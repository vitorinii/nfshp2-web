// Force-included in the builds outside Windows (Makefile: -include compat_posix.h): the MSVC C library names the runtime uses.
#pragma once
#ifndef _WIN32
#include <strings.h>
#define _stricmp strcasecmp
#define _strnicmp strncasecmp
#endif
