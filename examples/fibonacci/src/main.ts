import { comptime } from "comptime";
import { fibonacci } from "./math";

let input = 12;
let value = comptime(() => fibonacci(input));
let message = `fibonacci(${input}) = ${value}`;
let output = document.querySelector("#output");

if (output) {
  output.textContent = message;
}

console.log(message);
