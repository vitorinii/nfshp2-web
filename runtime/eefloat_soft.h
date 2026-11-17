// The host's float operations as eefloat.h needs them: rounded toward zero, denormal inputs taken as zero and denormal results flushed to
// zero. On x86-64 and arm64 that is the float unit's own mode (ee_float_mode, ps2.cpp) and these are the plain operators. WebAssembly has no
// rounding mode (always to nearest) and keeps denormals, so there (EE_SOFT_RTZ) each operation is done in double, where it is exact (an add of
// operands eefloat.h has masked spans 26 bits; a product 48) or cannot land on or cross a float boundary unless exact (a quotient's or a
// root's distance from one is at least 2^-48 of it), and the double is then cut to float toward zero. Checked against arm64's FPCR mode
// bit for bit: tests/eefloat_soft_test.cpp (add of masked operands, mul, div, sqrt, int to float; scalar and four lanes).
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>

#if defined(__wasm__) && !defined(EE_HARD_RTZ)
#define EE_SOFT_RTZ 1
#endif

typedef float ee_v4f __attribute__((vector_size(16)));
typedef uint32_t ee_v4u __attribute__((vector_size(16)));
typedef int32_t ee_v4i __attribute__((vector_size(16)));

#ifdef EE_SOFT_RTZ
typedef double ee_v2d __attribute__((vector_size(16)));
typedef float ee_v2f __attribute__((vector_size(8)));
typedef int64_t ee_v2l __attribute__((vector_size(16)));
typedef uint64_t ee_v2ul __attribute__((vector_size(16)));
typedef int32_t ee_v2i __attribute__((vector_size(8)));

static inline uint32_t ees_bits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static inline float ees_float(uint32_t u) { float f; memcpy(&f, &u, 4); return f; }

// a denormal input as the signed zero
static inline float ees_daz(float x)
{
    const uint32_t u = ees_bits(x);
    return (u & 0x7f800000u) ? x : ees_float(u & 0x80000000u);
}

// double to float toward zero, a denormal result flushed to the signed zero
static inline float ees_cut(double d)
{
    float f = (float)d;                                     // to nearest
    if (std::fabs((double)f) > std::fabs(d)) f = ees_float(ees_bits(f) - 1);   // rounded away from zero (or to infinity): one ulp back
    const uint32_t u = ees_bits(f);
    return (u & 0x7f800000u) ? f : ees_float(u & 0x80000000u);
}

static inline float ee_hadd(float a, float b) { return ees_cut((double)ees_daz(a) + (double)ees_daz(b)); }
static inline float ee_hmul(float a, float b) { return ees_cut((double)ees_daz(a) * (double)ees_daz(b)); }
static inline float ee_hdiv(float a, float b) { return ees_cut((double)ees_daz(a) / (double)ees_daz(b)); }
static inline float ee_hsqrt(float a) { return ees_cut(std::sqrt((double)ees_daz(a))); }
static inline float ee_hi2f(int32_t i) { return ees_cut((double)i); }

// ---- four lanes: two pairs of doubles (wasm's f64x2)
static inline ee_v4f ees_daz4(ee_v4f v)
{
    const ee_v4u u = (ee_v4u)v;
    const ee_v4u keep = (ee_v4u)((u & 0x7f800000u) != 0u);
    return (ee_v4f)(u & (keep | 0x80000000u));
}
static inline ee_v2d ees_abs2(ee_v2d d) { return (ee_v2d)((ee_v2ul)d & 0x7fffffffffffffffull); }
static inline ee_v4f ees_cut4(ee_v2d lo, ee_v2d hi)
{
    const ee_v2f flo = __builtin_convertvector(lo, ee_v2f), fhi = __builtin_convertvector(hi, ee_v2f);
    const ee_v2l olo = (ee_v2l)(ees_abs2(__builtin_convertvector(flo, ee_v2d)) > ees_abs2(lo));
    const ee_v2l ohi = (ee_v2l)(ees_abs2(__builtin_convertvector(fhi, ee_v2d)) > ees_abs2(hi));
    const ee_v4i over = __builtin_shufflevector(__builtin_convertvector(olo, ee_v2i), __builtin_convertvector(ohi, ee_v2i), 0, 1, 2, 3);
    ee_v4u u = (ee_v4u)__builtin_shufflevector(flo, fhi, 0, 1, 2, 3);
    u += (ee_v4u)over;                                      // -1 where it rounded away from zero
    const ee_v4u keep = (ee_v4u)((u & 0x7f800000u) != 0u);
    return (ee_v4f)(u & (keep | 0x80000000u));
}
#define EES_LO(v) __builtin_convertvector(__builtin_shufflevector(v, v, 0, 1), ee_v2d)
#define EES_HI(v) __builtin_convertvector(__builtin_shufflevector(v, v, 2, 3), ee_v2d)
static inline ee_v4f ee_hadd4(ee_v4f a, ee_v4f b)
{
    a = ees_daz4(a), b = ees_daz4(b);
    return ees_cut4(EES_LO(a) + EES_LO(b), EES_HI(a) + EES_HI(b));
}
static inline ee_v4f ee_hmul4(ee_v4f a, ee_v4f b)
{
    a = ees_daz4(a), b = ees_daz4(b);
    return ees_cut4(EES_LO(a) * EES_LO(b), EES_HI(a) * EES_HI(b));
}
#undef EES_LO
#undef EES_HI
#else
// the float unit is in the EE's mode (ee_float_mode): the plain operators are the EE's rounding
static inline float ee_hadd(float a, float b) { return a + b; }
static inline float ee_hmul(float a, float b) { return a * b; }
static inline float ee_hdiv(float a, float b) { return a / b; }
static inline float ee_hsqrt(float a) { return std::sqrt(a); }
static inline float ee_hi2f(int32_t i) { return (float)i; }
static inline ee_v4f ee_hadd4(ee_v4f a, ee_v4f b) { return a + b; }
static inline ee_v4f ee_hmul4(ee_v4f a, ee_v4f b) { return a * b; }
#endif
