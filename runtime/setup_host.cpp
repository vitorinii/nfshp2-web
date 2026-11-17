// Outside Windows there is no setup window: the game's folder is given (HP2_DATA, the page's /data mount), so the game just plays.
#include "setup.h"

SetupResult setup_start() { return SETUP_PLAY; }
