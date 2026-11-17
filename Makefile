# NFS Hot Pursuit 2 in the browser: the module, built from ZloiKILLER's port (upstream/, at the version setup.sh pins, with
# patches/nfshp2-web.patch applied) and this repository's own runtime files (runtime/).
#
#   make web         build/web/hp2.wasm    the browser module (wasi-sdk 34, wasm32-wasip1-threads)
#   make native      build/native/hp2      a headless macOS/Linux build (no picture, sound pulled in real time): for debugging
#   make test        build/eefloat_soft_test, run: the software float against the CPU's own (arm64 only)
#
# Needs upstream/work/recomp/gen, the game's code as C++ (setup.sh makes it from your disc). The generated code is compiled once per
# header change (-MMD).

UP   := upstream
RT   := $(UP)/recomp/runtime
OWN  := runtime
GEN  := $(UP)/work/recomp/gen
WASI ?= $(abspath $(lastword $(wildcard deps/wasi-sdk-*)))

GEN_SRC := $(wildcard $(GEN)/*.cpp)
COMMON  := ps2 mem_block pcmenu pcsettings pclang pcplatform native native_tex hle_iop dma vif profile hot_math native_mem memwatch \
           native_movie gs_regs pcconfig iop_cpu iop_kernel iop_libsd spu2 host disc window_host pad_host setup_host
NATIVE_ONLY := native_null audio_null host_native
WEB_ONLY    := native_web audio_web host_web
INCLUDES := -I$(OWN) -I$(RT) -I$(GEN)
vpath %.cpp $(OWN) $(RT)

# ---- web -------------------------------------------------------------------------------------------------------------------------
W_OUT  := build/web
W_CXX  := $(WASI)/bin/clang++
W_TARGET := --target=wasm32-wasip1-threads -pthread
W_FEAT := -msimd128 -mbulk-memory -mnontrapping-fptoint -msign-ext
W_FLAGS := $(W_TARGET) $(W_FEAT) -std=c++17 -w -fno-strict-aliasing -fno-exceptions -include compat_posix.h $(INCLUDES) -MMD -MP \
           -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS
W_GEN_OBJ := $(patsubst $(GEN)/%.cpp,$(W_OUT)/gen/%.o,$(GEN_SRC))
W_RT_OBJ  := $(patsubst %,$(W_OUT)/rt/%.o,$(COMMON) $(WEB_ONLY))
# memory: the game's 256 MB block and the runtime's heap; the page gives INITIAL_MB, it can grow to 4 GB
INITIAL_MB ?= 1024
W_LINK := -Wl,--import-memory,--export-memory,--shared-memory,--max-memory=4294967296 \
          -Wl,--initial-memory=$(shell echo $$(( $(INITIAL_MB) * 1048576 ))) \
          -Wl,-z,stack-size=$(shell echo $$(( 8 * 1048576 ))) \
          -Wl,--export=malloc -Wl,--export=free \
          -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks

web: check-gen $(W_OUT)/hp2.wasm
$(W_OUT)/hp2.wasm: $(W_GEN_OBJ) $(W_RT_OBJ)
	$(W_CXX) $(W_TARGET) $(W_FEAT) -o $@ $^ $(W_LINK) 2>&1 | tee $(W_OUT)/link.log
	@test -f $@ && echo "web OK: $@ ($$(( $$(wc -c < $@) / 1048576 )) MB)"
$(W_OUT)/gen/%.o: $(GEN)/%.cpp
	@mkdir -p $(dir $@)
	$(W_CXX) $(W_FLAGS) -O2 -c -o $@ $<
$(W_OUT)/rt/hot_math.o: XFLAGS := -ffp-contract=off
$(W_OUT)/rt/native_movie.o: XFLAGS := -fwrapv
$(W_OUT)/rt/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(W_CXX) $(W_FLAGS) -O2 $(XFLAGS) -c -o $@ $<

# ---- native ----------------------------------------------------------------------------------------------------------------------
N_OUT  := build/native
N_CXX  := clang++
N_FLAGS := -std=c++17 -w -fno-strict-aliasing -include compat_posix.h $(INCLUDES) -MMD -MP -g1
N_GEN_OBJ := $(patsubst $(GEN)/%.cpp,$(N_OUT)/gen/%.o,$(GEN_SRC))
N_RT_OBJ  := $(patsubst %,$(N_OUT)/rt/%.o,$(COMMON) $(NATIVE_ONLY))

native: check-gen $(N_OUT)/hp2
$(N_OUT)/hp2: $(N_GEN_OBJ) $(N_RT_OBJ)
	$(N_CXX) -o $@ $^ -lpthread
	@echo "native OK: $@"
$(N_OUT)/gen/%.o: $(GEN)/%.cpp
	@mkdir -p $(dir $@)
	$(N_CXX) $(N_FLAGS) -O1 -c -o $@ $<
$(N_OUT)/rt/hot_math.o: XFLAGS := -ffp-contract=off
$(N_OUT)/rt/native_movie.o: XFLAGS := -fwrapv
$(N_OUT)/rt/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(N_CXX) $(N_FLAGS) -O2 $(XFLAGS) -c -o $@ $<

# ---- the float test --------------------------------------------------------------------------------------------------------------
test: build/eefloat_soft_test
	build/eefloat_soft_test
build/eefloat_soft_test: tests/eefloat_soft_test.cpp $(OWN)/eefloat_soft.h
	@mkdir -p build
	clang++ -std=c++17 -O2 -ffp-contract=off -frounding-math -I$(OWN) $< -o $@

check-gen:
	@test -n "$(GEN_SRC)" || { echo "$(GEN) is empty: run ./setup.sh <your disc image> first"; exit 1; }

clean:
	rm -rf build

.PHONY: web native test check-gen clean
-include $(N_GEN_OBJ:.o=.d) $(N_RT_OBJ:.o=.d) $(W_GEN_OBJ:.o=.d) $(W_RT_OBJ:.o=.d)
