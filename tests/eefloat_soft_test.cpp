// eefloat_soft.h against the float unit in the EE's mode (round toward zero, flush to zero: ps2.cpp's ee_float_mode), arm64 only.
//   clang++ -std=c++17 -O2 -ffp-contract=off -frounding-math -I runtime tests/eefloat_soft_test.cpp -o build/eefloat_soft_test   (make test)
//   build/eefloat_soft_test [count] [control]     control: the hardware left to nearest, which must then differ
#define EE_SOFT_RTZ 1
#include "eefloat_soft.h"

#include <cstdio>
#include <cstdlib>

static void hw_mode()
{
    unsigned long fpcr;
    asm volatile("mrs %0, fpcr" : "=r"(fpcr));
    fpcr |= 3ul << 22 | 1ul << 24;
    asm volatile("msr fpcr, %0" : : "r"(fpcr));
}

__attribute__((noinline)) static float hw_add(float a, float b) { return a + b; }
__attribute__((noinline)) static float hw_mul(float a, float b) { return a * b; }
__attribute__((noinline)) static float hw_div(float a, float b) { return a / b; }
__attribute__((noinline)) static float hw_sqrt(float a) { return sqrtf(a); }
__attribute__((noinline)) static float hw_i2f(int32_t i) { return (float)i; }
__attribute__((noinline)) static ee_v4f hw_add4(ee_v4f a, ee_v4f b) { return a + b; }
__attribute__((noinline)) static ee_v4f hw_mul4(ee_v4f a, ee_v4f b) { return a * b; }

static uint64_t s = 0x9E3779B97F4A7C15ull;
static uint32_t rnd() { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return (uint32_t)(s >> 16); }
static uint32_t pick(uint32_t other)
{
    uint32_t u = rnd();
    switch (rnd() & 3) {
    case 0: break;
    case 1: u = (u & 0x807fffffu) | ((other & 0x7f800000u) + ((rnd() % 5 - 2) << 23)); break;
    case 2: u = (u & 0x807fffffu) | ((rnd() % 4) << 23); break;
    case 3: u = (u & 0x807fffffu) | ((251 + rnd() % 4) << 23); break;
    }
    if ((u & 0x7f800000u) == 0x7f800000u) u &= ~0x00800000u;
    return u;
}
// eefloat.h's masking of the smaller operand before an add
static void mask(uint32_t &x, uint32_t &y)
{
    const int d = (int)(x >> 23 & 255) - (int)(y >> 23 & 255);
    const int sy = d > 24 ? 31 : d - 1, sx = d < -24 ? 31 : -d - 1;
    y &= d > 0 ? ~0u << sy : ~0u;
    x &= d < 0 ? ~0u << sx : ~0u;
}

int main(int argc, char **argv)
{
    const long n = argc > 1 ? atol(argv[1]) : 10000000;
    if (argc <= 2) hw_mode();
    long bad[7] = {};
    for (long i = 0; i < n; i++) {
        uint32_t x = pick(0), y = pick(x), mx = x, my = y;
        mask(mx, my);
        const float ma = ees_float(mx), mb = ees_float(my), a = ees_float(x), b = ees_float(y);
        bad[0] += ees_bits(hw_add(ma, mb)) != ees_bits(ee_hadd(ma, mb));
        bad[1] += ees_bits(hw_mul(a, b)) != ees_bits(ee_hmul(a, b));
        if (y & 0x7f800000u) bad[2] += ees_bits(hw_div(a, b)) != ees_bits(ee_hdiv(a, b));
        const float p = ees_float(x & 0x7fffffffu);
        bad[3] += ees_bits(hw_sqrt(p)) != ees_bits(ee_hsqrt(p));
        bad[4] += ees_bits(hw_i2f((int32_t)x)) != ees_bits(ee_hi2f((int32_t)x));
        if ((i & 3) == 3) {     // four lanes from four draws
            ee_v4f va, vb, wa, wb;
            for (int k = 0; k < 4; k++) {
                uint32_t p1 = pick(0), q1 = pick(p1);
                wa[k] = ees_float(p1), wb[k] = ees_float(q1);
                mask(p1, q1);
                va[k] = ees_float(p1), vb[k] = ees_float(q1);
            }
            const ee_v4f h = hw_add4(va, vb), sres = ee_hadd4(va, vb), hm = hw_mul4(wa, wb), sm = ee_hmul4(wa, wb);
            for (int k = 0; k < 4; k++) bad[5] += ees_bits(h[k]) != ees_bits(sres[k]), bad[6] += ees_bits(hm[k]) != ees_bits(sm[k]);
        }
    }
    printf("%ld each%s: add %ld, mul %ld, div %ld, sqrt %ld, int->float %ld, add4 lanes %ld, mul4 lanes %ld\n", n,
           argc > 2 ? " (control, hardware to nearest)" : "", bad[0], bad[1], bad[2], bad[3], bad[4], bad[5], bad[6]);
    long any = 0;
    for (long b : bad) any |= b;
    return any ? 1 : 0;
}
