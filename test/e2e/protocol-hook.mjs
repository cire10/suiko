// @ts-check
// Module resolve hook for Node tests of UI modules: the browser resolves the UI's bare `protocol` import through the
// import map of src/ui/index.html (/ui-shared/protocol.js); here it points at src/shared/protocol.js. Registered with
// module.register().

/**
 * @param {string} specifier
 * @param {any} context
 * @param {(specifier: string, context: any) => Promise<any>} next
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'protocol') return { url: new URL('../../src/shared/protocol.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
