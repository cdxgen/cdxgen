project('brotli-consumer', 'c', version: '1.0.0')
brotli_dep = dependency('libbrotlidec', fallback: ['google-brotli', 'brotli_decoder_dep'])
executable('app', 'main.c', dependencies: brotli_dep)
