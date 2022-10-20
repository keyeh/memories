#!/bin/sh

exifver="12.49"

rm -rf exiftool-bin
mkdir -p exiftool-bin
cd exiftool-bin
wget "https://github.com/pulsejet/exiftool-bin/releases/download/$exifver/exiftool-amd64-musl"
wget "https://github.com/pulsejet/exiftool-bin/releases/download/$exifver/exiftool-amd64-glibc"
wget "https://github.com/pulsejet/exiftool-bin/releases/download/$exifver/exiftool-aarch64-musl"
wget "https://github.com/pulsejet/exiftool-bin/releases/download/$exifver/exiftool-aarch64-glibc"
chmod 755 *

wget "https://github.com/exiftool/exiftool/archive/refs/tags/$exifver.zip"
unzip "$exifver.zip"
mv "exiftool-$exifver" exiftool
rm -rf *.zip exiftool/t exiftool/html
chmod 755 exiftool/exiftool

cd ..