import type { IsOdd } from "is-odd";
import isEven from "is-even";

export function checkNumber(value: number): boolean {
  const checkOdd: IsOdd = (val) => val % 2 !== 0;
  return isEven(value);
}
