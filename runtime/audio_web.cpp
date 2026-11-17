// The sound in the browser: the SPU2's 48 kHz stereo frames into a ring in the shared memory, which the page's AudioWorklet plays
// (web/src/audio.js). A thread of ours keeps the ring about RING_AHEAD frames ahead of what the worklet has read; the worklet's reads pace it,
// as a device's callback paces audio_wasapi.cpp's.
#include "audio_out.h"
#include "host_web.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

extern FILE *g_hle_log;

#define AUDIO_MAGIC 0x44554148u         // "HAUD"
static const uint32_t RING = 8192;      // frames, a power of two
static const uint32_t RING_AHEAD = 2400; // 50 ms
static const uint32_t CHUNK = 240;      // 5 ms

struct AudioRing {
    uint32_t magic, rate, capacity, data;   // data: the ring's address, s16 frames L R
    uint32_t written;                       // frames written, counting (the runtime)
    uint32_t read;                          // frames read, counting (the worklet)
    uint32_t underruns;                     // the worklet: frames it had to make up
    uint32_t running;                       // the worklet is playing
};

static AudioRing g_ring;
static int16_t g_data[RING * 2];

bool audio_out_start(AudioPull pull)
{
    g_ring = {AUDIO_MAGIC, AUDIO_RATE, RING, (uint32_t)(uintptr_t)g_data, 0, 0, 0, 0};
    hp2_register(HOST_KIND_AUDIO, &g_ring, sizeof g_ring);
    std::thread([pull] {
        int16_t buf[CHUNK * 2];
        for (;;) {
            const uint32_t written = __atomic_load_n(&g_ring.written, __ATOMIC_ACQUIRE);
            const uint32_t read = __atomic_load_n(&g_ring.read, __ATOMIC_ACQUIRE);
            // until the worklet runs, the game's streams move at their own rate all the same: as if read in real time
            const bool playing = __atomic_load_n(&g_ring.running, __ATOMIC_ACQUIRE) != 0;
            if (!playing) {
                static auto next = std::chrono::steady_clock::now();
                pull(buf, CHUNK);
                next += std::chrono::microseconds(CHUNK * 1000000ull / AUDIO_RATE);
                std::this_thread::sleep_until(next);
                continue;
            }
            if (written - read < RING_AHEAD) {
                pull(buf, CHUNK);
                const uint32_t at = written % RING;
                const uint32_t first = RING - at < CHUNK ? RING - at : CHUNK;
                memcpy(g_data + at * 2, buf, first * 4);
                if (first < CHUNK) memcpy(g_data, buf + first * 2, (CHUNK - first) * 4);
                __atomic_store_n(&g_ring.written, written + CHUNK, __ATOMIC_RELEASE);
                continue;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }).detach();
    return true;
}
