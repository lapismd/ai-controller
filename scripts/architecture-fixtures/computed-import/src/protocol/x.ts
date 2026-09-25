const path = "./y.js";
export async function load() {
  return import(path);
}
