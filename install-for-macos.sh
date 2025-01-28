#!/bin/bash

set -e

(
  cd node_modules/@bocoup/macos-at-driver-server/MacOSATDriverServer/Build/Debug

  # Remove quarantine
  xattr -r -d com.apple.quarantine MacOSATDriverServer.app

  auval -v ausp atdg BOCU || true

  # Register extension
  /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister \
    -f -R -trusted MacOSATDriverServer.app

  auval -v ausp atdg BOCU || true
)

# Enable extension
pluginkit -e use -i com.bocoup.MacOSATDriverServer.MacOSATDriverServerExtension

auval -v ausp atdg BOCU || true

defaults read com.apple.Accessibility SpeechVoiceIdentifierForLanguage || true

# Set system voice
defaults write com.apple.Accessibility SpeechVoiceIdentifierForLanguage '{2 = {en = "com.bocoup.MacOSATDriverServer.MacOSATDriverServerExtension.MacOSATDriverServerExtension";};}'

auval -v ausp atdg BOCU || true
