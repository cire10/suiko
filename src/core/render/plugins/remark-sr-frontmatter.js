// @ts-check
// remark plugin: turns a YAML/TOML front-matter node (from remark-frontmatter) into a code node
// (lang yaml|toml, meta 'sr-frontmatter') so it renders, keeps its position and is commentable.
// The marker travels as a data-sr-frontmatter property on the <code> element (hast `data` does not survive
// rehype-raw); rehype-sr-prepare removes it and wraps the <pre> in <details class="sr-frontmatter">.

export const FRONTMATTER_META = 'sr-frontmatter';
/** hast property set on the front-matter <code> element. */
export const FRONTMATTER_PROP = 'dataSrFrontmatter';

/**
 * @returns {(tree: any) => void}
 */
export default function remarkSrFrontmatter() {
  return (tree) => {
    if (!tree || !Array.isArray(tree.children)) return;
    tree.children = tree.children.map((/** @type {any} */ node) => {
      if (node.type !== 'yaml' && node.type !== 'toml') return node;
      return {
        type: 'code', lang: node.type, meta: FRONTMATTER_META, value: node.value ?? '', position: node.position,
        data: { hProperties: { [FRONTMATTER_PROP]: 'true' } },
      };
    });
  };
}
