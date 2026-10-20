declare module "*.mdx" {
  import type { ComponentType } from "react";
  import type { MDXComponents } from "mdx/types";
  const contenido: ComponentType<{ components?: MDXComponents }>;
  export default contenido;
}
