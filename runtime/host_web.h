// The wasm side of the page contract: blocks the runtime shares with the page, made known with hp2_register(kind, ptr, size). The page
// side is web/src/host.js (the same numbers). Everything in a block is fixed-width: wasm32's long is 32 bits.
#pragma once
#include <cstdint>

enum {
    HOST_KIND_INPUT = 1,    // HostInput (host_input.h)
    HOST_KIND_GPU = 2,      // the renderer's control block (native_web.h)
    HOST_KIND_AUDIO = 3,    // the sound's ring (audio_web.cpp)
};

extern "C" __attribute__((import_module("hp2"), import_name("register"))) int hp2_register(int kind, void *ptr, uint32_t size);
