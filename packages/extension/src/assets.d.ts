// SVGs are bundled as text by esbuild (see build.mjs).
declare module "*.svg" {
  const content: string;
  export default content;
}
