// The renderer's contract between native_web.cpp (the render thread, in wasm) and the page's WebGPU renderer (web/src/gpu.js): a frame of
// native.h's NativeFrame, laid out in fixed-width records in the shared memory. The page reads it in place and says when it is done with it;
// till then nothing in it moves. Every field is 32 bits; the page's offsets are gpu.js's (WF_*, WD_*, WU_*), checked by the size words.
#pragma once
#include <cstdint>

#define GPU_MAGIC 0x46325048u           // "HP2F"
#define GPU_VERSION 1u

// GpuCtl.state: the handoff word. The render thread publishes a frame (READY); the page takes it (CAS READY -> TAKEN), encodes it, and
// stores DONE; the render thread then sets it back to EMPTY. A frame the page has not taken in time is taken back (CAS READY -> EMPTY): dropped.
enum { GPU_EMPTY = 0, GPU_READY = 1, GPU_TAKEN = 2, GPU_DONE = 3 };

struct GpuCtl {
    uint32_t magic, version, size;
    int32_t state;
    uint32_t frame;             // WFrame's address
    int32_t attached;           // the page: 1 once its renderer is ready
    uint32_t frames_done;       // the page: frames drawn
    uint32_t features;          // the page: 1 clip distances, 2 depth clip control (unclipped depth)
    uint32_t saved;             // counts up for each "SAVED" notice (native_notice_saved)
    uint32_t depth_seq;         // the page: bumped when it wrote a frame's depth rects into depth_buf
    uint32_t depth_buf, depth_cap;  // where the page writes them (the runtime's buffer), and its size in bytes
    uint32_t depth_frame;       // the page: the frame number those rects are of
    uint32_t errors;            // the page: WebGPU validation errors seen
    uint32_t wframe_size, wdraw_size, wupload_size, wfx_size;   // the records' sizes, for the page to check
    uint32_t reserved[12];
};

struct WDraw {
    float clip[16];
    uint32_t first, count;
    uint32_t tex;               // the texture's id, 0 none, 0xFFFFFFFF one not on the GPU yet (the draw is skipped)
    int32_t rt;                 // >= 0: a picture of the renderer's (NATIVE_RT_*)
    uint32_t bits;              // 1 depth write, 2 alpha test, 4 depth test, 8 indexed, 16 the texture upscaled, 32 its min filter linear
    uint32_t blend;             // NativeBlend
    float blend_fix;
    float scroll_s, scroll_t;
    uint32_t tex_mode;
    float snap_x, snap_y;
    float view[4];
    uint32_t tfx, lod_l, target, flags;
    int32_t light;
    uint32_t pad[3];
};

struct WUpload {
    uint32_t tex;               // its id
    uint32_t w, h, levels;
    uint32_t px;                // the levels one after another, RGBA8 with the GS's bytes
    uint32_t px_count;          // in texels
    uint32_t sampler;           // 1 repeat s, 2 repeat t, 4 mag linear, 8 min linear, 16 mip linear
    uint32_t image_w, image_h;
    uint32_t pad[3];
};

struct WFx {
    uint32_t at, kind, darken;
    float rect[4];
    uint32_t palette[256];
    uint32_t pad;
};

struct WFrame {
    uint32_t magic, seq, number;
    uint32_t vertices, vertex_count;    // NativeVertex, 32 bytes each
    uint32_t indices, index_count;      // u32
    uint32_t draws, draw_count;         // WDraw
    uint32_t lights, light_count;       // NativeLight, 22 vec4 each
    uint32_t fx, fx_count;              // WFx
    uint32_t uploads, upload_count;     // WUpload
    uint32_t freed, freed_count;        // u32 ids of textures let go
    uint32_t wide, env_linear;
    uint32_t road_specular, env_override, road_mode, env_mode;   // texture ids (0 none)
    uint32_t samples, back_samples;     // ReflectionSamples (6 * 49 * 28 bytes), BackReflectionSamples (4 * 49 * 28)
    uint32_t depth_rects, depth_rect_count;     // NativeDepthRect: x, y, w, h (GS pixels)
    float narrow;                       // native_narrow(): 4:3 over the race's aspect
    uint32_t scale;                     // the picture: this many times 512 x 448
    int32_t brightness, contrast, gamma, aa_mode, aa_level, smooth, show_fps, reflections;
    // the vertex cache (native.h): the strips new to it this frame, NativeFreshRun {dst, src, count} into it from `fresh`; the frame's own
    // vertices go in after the cache, at dyn_base, and non-indexed draws count from there
    uint32_t fresh, fresh_count, fresh_runs, fresh_run_count, dyn_base;
    uint32_t pad[2];
};
