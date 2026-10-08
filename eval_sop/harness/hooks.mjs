// Module resolve hook: redirect @supabase/supabase-js to the local JSON mock.
const MOCK = new URL("./supabase-mock.mjs", import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === "@supabase/supabase-js") return { url: MOCK, shortCircuit: true };
  return next(specifier, context);
}
