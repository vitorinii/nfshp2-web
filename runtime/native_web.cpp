// The renderer in the browser, the runtime's side (native_web.h): each frame of native.cpp laid out for the page's WebGPU renderer
// (web/src/gpu.js), which reads it in place in the shared memory. The textures get ids and are let go as native_vk.cpp lets them go (not
// drawn for 900 frames); what the GPU does with a frame (the passes of each strip, the effects, the picture into the canvas) is the page's.
// The vertex cache is native_vk.cpp's: the page keeps CACHE_VERTS of the strips in the GPU's buffer and the game sends each strip once; a frame
// the page does not draw loses the strips it brought, so the cache is emptied (g_native_epoch) as Vulkan's was.
#include "native.h"
#include "native_web.h"
#include "host_web.h"
#include "pcconfig.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>

extern FILE *g_hle_log;

std::atomic<uint32_t> g_native_epoch{0};

static const uint32_t CACHE_VERTS = 3u << 20;     // 96 MB of the GPU's buffer
static const uint32_t DYN_VERTS = 2u << 20;       // a frame's own vertices after it: gpu.js makes the buffer this size
static std::atomic<uint32_t> g_cache_cap_pub{0};  // what the game's thread is told: 0 till the page is there

static GpuCtl g_ctl = [] {
    GpuCtl c = {};
    c.magic = GPU_MAGIC;
    c.version = GPU_VERSION;
    c.size = sizeof(GpuCtl);
    c.wframe_size = sizeof(WFrame);
    c.wdraw_size = sizeof(WDraw);
    c.wupload_size = sizeof(WUpload);
    c.wfx_size = sizeof(WFx);
    return c;
}();
static bool g_registered;

// the depth of a recent frame's rects (eTransferZBufferRect), as the page read them back (native_vk_depth). The page's readback comes a
// frame or more late, so it says which rects it is: the count, each rect's x y w h, then each rect's words (the GS's PSMZ24), in that order
static std::vector<uint32_t> g_depth_buf(256 * 1024);
static std::vector<uint32_t> g_depth_have;
static uint32_t g_depth_seq_seen;

// ---- textures --------------------------------------------------------------------------------------------------------------------
struct WebTex {
    NativeTexture *owner;
    uint32_t used, born;
};
static std::vector<WebTex> g_tex;                       // by id - 1
static std::vector<uint32_t> g_free_ids;
static std::vector<NativeTexUpload> g_tex_pending;     // decoded, not yet taken by the page, in order
static uint32_t g_frame;                                // frames the page took

static uint32_t tex_id(const NativeTexture *t) { return t ? (uint32_t)(uintptr_t)t->vk : 0; }

static uint32_t new_id(NativeTexture *owner)
{
    uint32_t id;
    if (!g_free_ids.empty()) {
        id = g_free_ids.back();
        g_free_ids.pop_back();
    } else {
        g_tex.push_back({});
        id = (uint32_t)g_tex.size();
    }
    g_tex[id - 1] = {owner, g_frame, g_frame};
    return id;
}

// ---- the wait ------------------------------------------------------------------------------------------------------------------
static int32_t load(const int32_t &v) { return __atomic_load_n(&v, __ATOMIC_ACQUIRE); }
static void wait_while(int32_t *at, int32_t value, int64_t ns) { __builtin_wasm_memory_atomic_wait32(at, value, ns); }

bool native_vk_draw(NativeFrame &frame)
{
    if (!g_registered) {
        g_registered = true;
        hp2_register(HOST_KIND_GPU, &g_ctl, sizeof g_ctl);
    }
    // the textures first, whatever comes of the frame: the game's thread counts them as loaded
    for (NativeTexUpload &u : frame.uploads) g_tex_pending.push_back(std::move(u));
    frame.uploads.clear();
    if (!load(g_ctl.attached)) return false;            // no renderer yet: the uploads wait for it
    if (frame.epoch != g_native_epoch.load()) return false;
    if (!g_cache_cap_pub.load()) g_cache_cap_pub.store(CACHE_VERTS);     // the page is there: the game's thread may cache from now on
    // made for a cache of another size (the first frames), or more than the buffer takes: not drawn, and the cache starts again
    if (frame.dyn_base != g_cache_cap_pub.load() || frame.vertices.size() > DYN_VERTS) {
        if (frame.vertices.size() > DYN_VERTS) fprintf(g_hle_log, "native: %zu vertices are more than a frame takes; not drawn\n", frame.vertices.size());
        g_cache_cap_pub.store(CACHE_VERTS);
        g_native_epoch++;
        return false;
    }

    // the uploads that go with this frame: the newest of each texture, each with its id
    static std::vector<WUpload> uploads;
    static std::vector<size_t> sent;
    uploads.clear();
    sent.clear();
    for (size_t i = 0; i < g_tex_pending.size(); i++) {
        NativeTexUpload &u = g_tex_pending[i];
        bool newer = false;
        for (size_t later = i + 1; later < g_tex_pending.size() && !newer; later++) newer = g_tex_pending[later].tex == u.tex;
        sent.push_back(i);
        if (newer || !u.tex || u.px.empty()) continue;
        if (!u.tex->vk) u.tex->vk = (void *)(uintptr_t)new_id(u.tex);
        WUpload w = {};
        w.tex = tex_id(u.tex);
        w.w = (uint32_t)u.w, w.h = (uint32_t)u.h, w.levels = (uint32_t)u.levels;
        w.px = (uint32_t)(uintptr_t)u.px.data();
        w.px_count = (uint32_t)u.px.size();
        w.sampler = (u.repeat_s ? 1 : 0) | (u.repeat_t ? 2 : 0) | (u.mag_linear ? 4 : 0) | (u.min_linear ? 8 : 0) | (u.mip_linear ? 16 : 0);
        w.image_w = (uint32_t)u.tex->image_w, w.image_h = (uint32_t)u.tex->image_h;
        uploads.push_back(w);
    }

    // the draws, with their textures' ids
    static std::vector<WDraw> draws;
    draws.resize(frame.draws.size());
    for (size_t i = 0; i < frame.draws.size(); i++) {
        const NativeDraw &d = frame.draws[i];
        WDraw &w = draws[i];
        memcpy(w.clip, d.clip, sizeof w.clip);
        w.first = d.first, w.count = d.count;
        w.tex = d.tex ? (d.tex->vk ? tex_id(d.tex) : 0xFFFFFFFFu) : 0;
        if (d.tex && d.tex->vk && d.count) g_tex[tex_id(d.tex) - 1].used = g_frame;
        w.rt = d.rt;
        w.bits = (d.depth_write ? 1 : 0) | (d.alpha_test ? 2 : 0) | (d.depth_test ? 4 : 0) | (d.indexed ? 8 : 0) | (d.tex_upscaled ? 16 : 0) |
                 (d.tex_min_linear ? 32 : 0);
        w.blend = d.blend;
        w.blend_fix = d.blend_fix;
        w.scroll_s = d.scroll_s, w.scroll_t = d.scroll_t;
        w.tex_mode = d.tex_mode;
        w.snap_x = d.snap_x, w.snap_y = d.snap_y;
        memcpy(w.view, d.view, sizeof w.view);
        w.tfx = d.tfx, w.lod_l = d.lod_l, w.target = d.target, w.flags = d.flags;
        w.light = d.light;
    }
    if (frame.road_specular && frame.road_specular->vk) g_tex[tex_id(frame.road_specular) - 1].used = g_frame;
    if (frame.env_override && frame.env_override->vk) g_tex[tex_id(frame.env_override) - 1].used = g_frame;

    static std::vector<WFx> fx;
    fx.resize(frame.fx.size());
    for (size_t i = 0; i < frame.fx.size(); i++) {
        const NativeFx &f = frame.fx[i];
        fx[i].at = f.at, fx[i].kind = f.kind, fx[i].darken = f.darken;
        memcpy(fx[i].rect, f.rect, sizeof f.rect);
        memcpy(fx[i].palette, f.palette, sizeof f.palette);
    }

    // what has not been drawn for a quarter of a minute goes (native_vk.cpp's rule): a few a frame, and not one the game's thread has
    // asked for since
    static std::vector<uint32_t> freed;
    freed.clear();
    {
        static size_t cursor;
        int n = 0;
        for (int looked = 0; looked < 64 && !g_tex.empty() && n < 2; looked++) {
            if (cursor >= g_tex.size()) cursor = 0;
            WebTex &t = g_tex[cursor];
            const uint32_t id = (uint32_t)cursor + 1;
            cursor++;
            if (!t.owner || g_frame - t.used <= 900) continue;
            std::lock_guard<std::mutex> hold(g_native_tex_mutex);
            if (frame.number < t.owner->frame || frame.number - t.owner->frame <= 900) continue;
            bool pending = false;
            for (const NativeTexUpload &u : g_tex_pending) pending = pending || u.tex == t.owner;
            if (pending) continue;
            t.owner->vk = nullptr;
            t.owner->loaded = false;
            t.owner = nullptr;
            freed.push_back(id);
            g_free_ids.push_back(id);
            n++;
        }
    }

    static WFrame wf;
    wf = {};
    wf.magic = GPU_MAGIC;
    wf.seq = g_frame;
    wf.number = frame.number;
    wf.vertices = (uint32_t)(uintptr_t)frame.vertices.data(), wf.vertex_count = (uint32_t)frame.vertices.size();
    wf.indices = (uint32_t)(uintptr_t)frame.indices.data(), wf.index_count = (uint32_t)frame.indices.size();
    wf.draws = (uint32_t)(uintptr_t)draws.data(), wf.draw_count = (uint32_t)draws.size();
    wf.lights = (uint32_t)(uintptr_t)frame.lights.data(), wf.light_count = (uint32_t)frame.lights.size();
    wf.fx = (uint32_t)(uintptr_t)fx.data(), wf.fx_count = (uint32_t)fx.size();
    wf.uploads = (uint32_t)(uintptr_t)uploads.data(), wf.upload_count = (uint32_t)uploads.size();
    wf.freed = (uint32_t)(uintptr_t)freed.data(), wf.freed_count = (uint32_t)freed.size();
    wf.wide = frame.wide, wf.env_linear = frame.env_linear;
    wf.road_specular = tex_id(frame.road_specular), wf.env_override = tex_id(frame.env_override);
    wf.road_mode = frame.road_mode, wf.env_mode = frame.env_mode;
    wf.samples = (uint32_t)(uintptr_t)frame.samples, wf.back_samples = (uint32_t)(uintptr_t)frame.back_samples;
    wf.depth_rects = (uint32_t)(uintptr_t)frame.depth_rects.data(), wf.depth_rect_count = (uint32_t)frame.depth_rects.size();
    wf.narrow = native_narrow();
    wf.scale = (uint32_t)g_cfg.scale;
    wf.brightness = g_cfg.brightness, wf.contrast = g_cfg.contrast, wf.gamma = g_cfg.gamma;
    wf.aa_mode = g_cfg.aa_mode, wf.aa_level = g_cfg.aa_level, wf.smooth = g_cfg.smooth, wf.show_fps = g_cfg.show_fps;
    wf.reflections = g_cfg.reflections;
    wf.fresh = (uint32_t)(uintptr_t)frame.fresh.data(), wf.fresh_count = (uint32_t)frame.fresh.size();
    wf.fresh_runs = (uint32_t)(uintptr_t)frame.fresh_runs.data(), wf.fresh_run_count = (uint32_t)frame.fresh_runs.size();
    wf.dyn_base = frame.dyn_base;
    g_ctl.depth_buf = (uint32_t)(uintptr_t)g_depth_buf.data();
    g_ctl.depth_cap = (uint32_t)(g_depth_buf.size() * 4);
    g_ctl.frame = (uint32_t)(uintptr_t)&wf;

    // to the page, and back: it reads the frame in place, so nothing here moves until it says DONE
    __atomic_store_n(&g_ctl.state, GPU_READY, __ATOMIC_RELEASE);
    __builtin_wasm_memory_atomic_notify(&g_ctl.state, 1);
    const auto t0 = std::chrono::steady_clock::now();
    bool drawn = false;
    for (;;) {
        const int32_t st = load(g_ctl.state);
        if (st == GPU_DONE) {
            drawn = true;
            break;
        }
        if (st == GPU_READY && std::chrono::steady_clock::now() - t0 > std::chrono::milliseconds(250)) {
            // the page did not take it (a tab in the background): taken back, unless it is just being taken
            int32_t expect = GPU_READY;
            if (__atomic_compare_exchange_n(&g_ctl.state, &expect, GPU_EMPTY, false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) break;
            continue;
        }
        wait_while(&g_ctl.state, st, 50 * 1000 * 1000);
    }
    __atomic_store_n(&g_ctl.state, GPU_EMPTY, __ATOMIC_RELEASE);
    if (!drawn) {
        g_native_epoch++;                               // its new strips never reached the cache
        return false;
    }
    g_frame++;
    {   // HP2_NATIVELOG: the game's thread on a frame's lists and textures, a line a second
        static const bool log = getenv("HP2_NATIVELOG") != nullptr;
        static double list_ms, tex_ms, worst;
        static uint32_t n;
        static auto at = std::chrono::steady_clock::now();
        list_ms += frame.list_ms, tex_ms += frame.tex_ms, n++;
        if (frame.list_ms + frame.tex_ms > worst) worst = frame.list_ms + frame.tex_ms;
        const auto now = std::chrono::steady_clock::now();
        if (log && now - at >= std::chrono::seconds(1)) {
            fprintf(g_hle_log, "native: %u frames, lists %.2f ms, textures %.2f ms a frame (worst %.1f), cache %u\n", n, list_ms / n, tex_ms / n, worst,
                    g_cache_cap_pub.load());
            list_ms = tex_ms = worst = 0, n = 0, at = now;
        }
    }
    // the uploads went with it
    g_tex_pending.erase(g_tex_pending.begin(), g_tex_pending.begin() + (ptrdiff_t)sent.size());
    // the rects the page read back: the next frame's native_vk_depth
    const uint32_t seq = __atomic_load_n(&g_ctl.depth_seq, __ATOMIC_ACQUIRE);
    if (seq != g_depth_seq_seen) {
        g_depth_seq_seen = seq;
        g_depth_have = g_depth_buf;
    }
    return true;
}

uint32_t native_vk_cache_vertices() { return g_cache_cap_pub.load(); }

bool native_vk_limits(int &aa, int &aniso)
{
    aa = 0;
    aniso = 0;
    return load(g_ctl.attached) != 0;
}

// a recent frame's depth over a rect, the GS's PSMZ24 words, if the page's last readback had that rect
bool native_vk_depth(const NativeDepthRect &r, uint32_t *out)
{
    if (g_depth_have.empty()) return false;
    const uint32_t n = g_depth_have[0];
    size_t at = 1 + (size_t)n * 4;
    for (uint32_t k = 0; k < n && 1 + k * 4 + 3 < g_depth_have.size(); k++) {
        const int32_t *h = (const int32_t *)&g_depth_have[1 + k * 4];
        const size_t words = (size_t)h[2] * (size_t)h[3];
        if (h[0] == r.x && h[1] == r.y && h[2] == r.w && h[3] == r.h) {
            if (at + words > g_depth_have.size()) return false;
            memcpy(out, g_depth_have.data() + at, words * 4);
            return true;
        }
        at += words;
    }
    return false;
}

void native_notice_saved() { __atomic_fetch_add(&g_ctl.saved, 1u, __ATOMIC_RELAXED); }
