#include <stdio.h>
#include <brotli/decode.h>
int main(void) { printf("%x\n", BrotliDecoderVersion()); return 0; }
