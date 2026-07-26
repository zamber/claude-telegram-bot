#!/usr/bin/env bash
head -c 10000 /dev/zero | tr '\0' 'x'
echo
