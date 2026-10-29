# encoding: ascii-8bit
# frozen-string-literal: false
#
# The module storing Ruby interpreter configurations on building.
#
# This file was created by mkconfig.rb when ruby was built.  It contains
# build information for ruby which is used e.g. by mkmf to build
# compatible native extensions.  Any changes made to this file will be
# lost the next time ruby is built.

module RbConfig
  CONFIG["MAJOR"] = "3"
  CONFIG["MINOR"] = "4"
  CONFIG["TEENY"] = "10"
  CONFIG["PATCHLEVEL"] = "104"
  CONFIG["prefix"] = (TOPDIR || DESTDIR + "/ucrt64")
  CONFIG["RUBY_SO_NAME"] = "x64-ucrt-$(RUBY_BASE_NAME)$(MAJOR)$(MINOR)0"
  CONFIG["ruby_version"] = "3.4.0"
  CONFIG["arch"] = "x64-mingw-ucrt"
  CONFIG["LIBRUBY_SO"] = "$(RUBY_SO_NAME).dll"
  CONFIG["RUBY_BASE_NAME"] = "ruby"
  CONFIG["RUBY_PROGRAM_VERSION"] = "$(MAJOR).$(MINOR).$(TEENY)"
end
