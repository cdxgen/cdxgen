# A small, working make file that exercises the formulation parser:
# real targets, a special target to skip, an include, variables and a
# docker-flavoured target.
CC ?= cc
CXX ?= c++
CFLAGS := -O2 -Wall

include extra.mk

.PHONY: all clean test

all: demo

demo: main.o util.o
	$(CC) $(CFLAGS) -o $@ $^

main.o: main.c
	$(CC) $(CFLAGS) -c $< -o $@

util.o: util.c util.h
	$(CC) $(CFLAGS) -c $< -o $@

test: demo
	./demo --selftest

docker-build:
	docker build -t demo:local .

clean:
	rm -f *.o demo
