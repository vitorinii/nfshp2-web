// The sound of a headless run: the SPU2's frames pulled at their own rate (48 kHz, 10 ms at a time) so the game's streams move as with a
// device, and thrown away, or written to HP2_WAV=<file> (a WAV of the first minutes, to listen to what a run played).
#include "audio_out.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <vector>

static void wav_header(FILE *f, uint32_t frames)
{
    const uint32_t data = frames * 4, riff = 36 + data, fmt = 16, rate = AUDIO_RATE, bytes = AUDIO_RATE * 4;
    const uint16_t pcm = 1, ch = 2, align = 4, bits = 16;
    fseek(f, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, f), fwrite(&riff, 4, 1, f), fwrite("WAVEfmt ", 1, 8, f), fwrite(&fmt, 4, 1, f);
    fwrite(&pcm, 2, 1, f), fwrite(&ch, 2, 1, f), fwrite(&rate, 4, 1, f), fwrite(&bytes, 4, 1, f), fwrite(&align, 2, 1, f), fwrite(&bits, 2, 1, f);
    fwrite("data", 1, 4, f), fwrite(&data, 4, 1, f);
}

bool audio_out_start(AudioPull pull)
{
    std::thread([pull] {
        const char *path = getenv("HP2_WAV");
        FILE *wav = path ? fopen(path, "wb") : nullptr;
        if (wav) wav_header(wav, 0);
        const uint32_t max_frames = AUDIO_RATE * 300;      // five minutes at most
        uint32_t written = 0;
        const int chunk = AUDIO_RATE / 100;
        std::vector<s16> buf(chunk * 2);
        auto next = std::chrono::steady_clock::now();
        for (;;) {
            pull(buf.data(), chunk);
            if (wav && written < max_frames) {
                fwrite(buf.data(), 4, chunk, wav);
                written += chunk;
                if (written % (AUDIO_RATE * 5) < (uint32_t)chunk) {
                    const long at = ftell(wav);
                    wav_header(wav, written);
                    fseek(wav, at, SEEK_SET);
                    fflush(wav);
                }
            }
            next += std::chrono::milliseconds(10);
            std::this_thread::sleep_until(next);
        }
    }).detach();
    return true;
}
