// Ambient declarations for static image assets imported as ES modules.
// Metro resolves these to an opaque asset reference (a number in the asset
// registry) at bundle time; `<Image source>` accepts that number directly.
declare module '*.png' {
  const content: number;
  export default content;
}
