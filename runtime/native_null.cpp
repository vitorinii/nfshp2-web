// The renderer of a headless run (the native macOS/Linux build): the frames are taken and counted, nothing is drawn. A line a second says
// how many frames and draws came, so a run without a picture still shows the game going on.
#include "native.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <set>
#include <string>

extern FILE *g_hle_log;

std::atomic<uint32_t> g_native_epoch{0};

bool native_vk_draw(NativeFrame &frame)
{
    frame.uploads.clear();      // the textures count as loaded: never let go
    static uint64_t frames, draws, verts, last_s;
    frames++;
    draws += frame.draws.size();
    verts += frame.vertices.size() + frame.indices.size();
    const uint64_t s = (uint64_t)std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    if (s != last_s) {
        // the screen, by the names of the textures this frame draws with (the game's own names)
        std::string names;
        std::set<std::string> seen;
        for (const NativeDraw &d : frame.draws)
            if (d.tex && d.tex->name[0] && seen.insert(d.tex->name).second && seen.size() <= 24) names += std::string(" ") + d.tex->name;
        fprintf(stderr, "[null] game frame %u: %llu frames, %llu draws, %llu vertices/indices this second; textures:%s\n",
                (unsigned)frame.number, (unsigned long long)frames, (unsigned long long)draws, (unsigned long long)verts, names.c_str());
        frames = draws = verts = 0;
        last_s = s;
    }
    return true;
}

uint32_t native_vk_cache_vertices() { return 0; }

bool native_vk_limits(int &aa, int &aniso)
{
    aa = 0;
    aniso = 16;
    return true;
}

bool native_vk_depth(const NativeDepthRect &, uint32_t *) { return false; }

void native_notice_saved() {}
