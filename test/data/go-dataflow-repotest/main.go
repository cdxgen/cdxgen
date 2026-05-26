package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"

	"golang.org/x/crypto/chacha20poly1305"
)

func requestSecret(r *http.Request) string {
	return r.FormValue("key")
}

func aesSink(secret string) []byte {
	block, _ := aes.NewCipher([]byte(secret))
	gcm, _ := cipher.NewGCM(block)
	return gcm.Seal(nil, make([]byte, gcm.NonceSize()), []byte("payload"), nil)
}

func chachaSink(secret string) []byte {
	aead, _ := chacha20poly1305.NewX([]byte(secret))
	return aead.Seal(nil, make([]byte, aead.NonceSize()), []byte("payload"), nil)
}

func handler(w http.ResponseWriter, r *http.Request) {
	secret := requestSecret(r)
	digest := sha256.Sum256([]byte(secret))
	_, _ = w.Write(aesSink(secret))
	_, _ = w.Write(chachaSink(os.Getenv("APP_KEY")))
	_, _ = fmt.Fprintf(w, "%x", digest)
}

func main() {
	http.HandleFunc("/encrypt", handler)
	_ = http.ListenAndServe(":8080", nil)
}
