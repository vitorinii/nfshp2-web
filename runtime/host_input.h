// The input the host gives the game outside Windows (the browser page, or nothing in a headless run): one block in memory the page
// writes and the game's threads read, no calls. Keys by Windows virtual-key code, so window_host.cpp keeps window.cpp's bindings
// (hp2.ini stores virtual keys). The page side is web/src/input.js (same offsets; HOST_INPUT_VERSION guards the layout).
#pragma once
#include <cstdint>

#define HOST_INPUT_MAGIC 0x49505548u    // "HUPI"
#define HOST_INPUT_VERSION 1u

// A gamepad as SDL would give it (pad.cpp's Raw): the dead zone and the steering's curve are applied in pad_host.cpp, as on Windows
struct HostPad {
    int32_t ok;                         // connected
    int32_t mask;                       // pad.cpp's button bits (XInput's): 0x1 up .. 0x8 right, 0x10 start, 0x20 back, 0x40 L3,
                                        // 0x80 R3, 0x100 LB, 0x200 RB, 0x1000 south, 0x2000 east, 0x4000 west, 0x8000 north
    int32_t lt, rt;                     // 0..32767
    int32_t axis[4];                    // RX RY LX LY, -32768..32767, down and right positive
    int32_t playstation;                // its buttons are PlayStation's (the page knows from the pad's name)
    int32_t rumble_small, rumble_large; // the game's wish, for the page to play (small 0/1, large 0..255)
};

struct HostKeyEvent {
    int32_t vk, down, repeat;
};

struct HostInput {
    uint32_t magic, version, size;
    int32_t focused;                    // the page has the keyboard
    uint8_t keys[256];                  // by virtual key: 1 down
    int32_t caps_lock;
    float mouse_x, mouse_y;             // in the canvas, 0..1 of its width and height; < 0 outside
    int32_t mouse_buttons;              // bit 0 left, 1 right, 2 middle
    int32_t mouse_moves;                // counts up on every move (the game shows the pointer for 3 s after one)
    int32_t wheel;                      // notches, up positive, counting
    int32_t view_w, view_h;             // the canvas in device pixels
    HostPad pads[2];
    // key presses in order, for typing a name: the page writes at ev_head, the game reads up to it
    uint32_t ev_head, ev_tail;
    HostKeyEvent ev[64];
    int32_t quit;                       // the page asks the game to end
    int32_t cursor_wanted;              // the game: the menus' pointer is to show (the page hides its own otherwise)
    int32_t scene;                      // the game: what is on screen, for the page's touch controls: 0 nothing to point at (logos, films,
                                        // loading), 1 a screen with something to point at (menus, the pause menu, a replay), 2 driving
    int32_t typing;                     // the game: a name is being typed (the page brings up a phone's own keyboard)
};

HostInput &host_input();                // window_host.cpp
void host_input_publish();              // makes the block known to the page (web: host_register), once at the start
