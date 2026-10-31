/* Parser unit test only. It does not simulate or certify kernel enforcement. */
#include "../native/secure_file_posix.c"
#include <assert.h>
#include <stdio.h>
int main(void) {
  assert(hardlink_setting_enabled("1\n", 2));
  assert(!hardlink_setting_enabled("0\n", 2));
  assert(!hardlink_setting_enabled("2\n", 2));
  assert(!hardlink_setting_enabled("", 0));
  assert(!hardlink_setting_enabled("1", 1));
  assert(!hardlink_setting_enabled("01\n", 3));
  assert(!hardlink_setting_enabled("1\nx", 3));
  assert(!hardlink_setting_enabled(" 1\n", 3));
  puts("hardlink policy parser: 8 assertions passed");
  return 0;
}
