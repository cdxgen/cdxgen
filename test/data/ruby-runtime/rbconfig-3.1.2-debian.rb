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
  CONFIG["MINOR"] = "1"
  CONFIG["TEENY"] = "2"
  CONFIG["PATCHLEVEL"] = "20"
  CONFIG["prefix"] = (TOPDIR || DESTDIR + "/usr")
  CONFIG["RUBY_SO_NAME"] = "ruby-3.1"
  CONFIG["ruby_version"] = "3.1.0"
  CONFIG["arch"] = "aarch64-linux-gnu"
  CONFIG["LIBRUBY_SO"] = "lib$(RUBY_SO_NAME).$(SOEXT).$(RUBY_PROGRAM_VERSION)"
  CONFIG["RUBY_BASE_NAME"] = "ruby"
  CONFIG["RUBY_PROGRAM_VERSION"] = "$(MAJOR).$(MINOR).$(TEENY)"
end
