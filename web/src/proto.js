// What the page, the game's threads and the I/O worker share: the control block, the RPC slots and their numbers.

// ctl: an Int32Array on a SharedArrayBuffer of CTL_INTS
export const CTL_INTS = 1024;
export const CTL_NEXT_TID = 0;      // the next thread id (wasi thread-spawn)
export const CTL_EXIT = 1;          // 1 once the process ended
export const CTL_EXIT_CODE = 2;
export const CTL_IO_BELL = 3;       // bumped on every RPC posted; the I/O worker waits on it
export const CTL_SLEEP = 4;         // never written: threads sleep by waiting on it
export const CTL_POOL = 64;         // the pool's slots, 4 ints each: state, tid, start_arg, -
export const POOL_MAX = 64;
export const POOL_NONE = 0, POOL_IDLE = 1, POOL_CLAIMED = 2, POOL_RUN = 3, POOL_RUN_MAIN = 4;

// rpc: per game-thread slot, RPC_BYTES: i32 [0] state, [1] op, [2] result (a WASI errno), [3] arg count; i32 args from [4]; i64 args
// (BigInt64Array) from byte 128
export const RPC_BYTES = 256;
export const RPC_IDLE = 0, RPC_POSTED = 1, RPC_DONE = 2;
export const RPC_I32 = 4, RPC_I64_BYTE = 128;

// the file system calls the I/O worker serves
export const Op = {
  path_open: 1, fd_close: 2, fd_read: 3, fd_write: 4, fd_seek: 5, fd_fdstat_get: 6, fd_fdstat_set_flags: 7, fd_prestat_get: 8,
  fd_prestat_dir_name: 9, fd_readdir: 10, path_filestat_get: 11, path_create_directory: 12, path_remove_directory: 13,
  path_rename: 14, path_unlink_file: 15, path_readlink: 16, fd_filestat_get: 17, fd_sync: 18,
};
export const opName = n => Object.keys(Op).find(k => Op[k] === n) || `op ${n}`;

// WASI errno
export const E = { SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54,
  NOTEMPTY: 55, NOTSUP: 58, PERM: 63, ROFS: 69, SPIPE: 70 };

// the blocks the runtime registers (runtime/host_web.h)
export const HOST_KIND_INPUT = 1, HOST_KIND_GPU = 2, HOST_KIND_AUDIO = 3;
