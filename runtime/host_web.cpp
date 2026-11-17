// The browser build's host: the input block made known to the page.
#include "host_input.h"
#include "host_web.h"

void host_input_publish() { hp2_register(HOST_KIND_INPUT, &host_input(), sizeof(HostInput)); }
