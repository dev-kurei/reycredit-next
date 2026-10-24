/** @type {import('next').NextConfig} */
module.exports = {
  async rewrites() {
    return [{ source: '/', destination: '/index.html' }];
  },
  // The PDF generator locates its font file at runtime via a path built from
  // require.resolve(), which Vercel's file-tracing step cannot follow statically
  // the way it can a plain string import. Without this, the .ttf files can be
  // pruned from the deployed function and the first PDF in production throws
  // "ENOENT" for a file that was there the whole time locally.
  //
  // On Next.js 14 this option only takes effect nested under `experimental` --
  // it did not move to the top level until Next.js 15.
  experimental: {
    outputFileTracingIncludes: {
      // dejavu-fonts-ttf: the Unicode font this app registers for the peso sign.
      // pdfkit: the library @react-pdf/renderer draws through. It loads its own
      // standard PDF fonts (Helvetica, Courier, etc.) from files on disk every
      // time it creates a document, regardless of which font the document
      // actually uses, and those files reference still more files of their own
      // (a nested "chunks" folder pdfkit ships internally). Cherry-picking
      // specific subfolders here turned into whack-a-mole -- each deploy
      // surfaced a different missing file one level deeper -- so the whole
      // package (11MB, comfortably small) is included instead of trying to
      // predict which paths pdfkit will reach for next.
      '/api/rpc': [
        './node_modules/dejavu-fonts-ttf/ttf/*.ttf',
        './node_modules/pdfkit/**/*',
      ],
      '/api/cron': [
        './node_modules/dejavu-fonts-ttf/ttf/*.ttf',
        './node_modules/pdfkit/**/*',
      ],
    },
    // Without this, webpack tries to statically bundle require.resolve() calls
    // used to locate the font file at runtime, and replaces the real string
    // path with its own internal numeric module id instead -- the exact cause
    // of "The 'path' argument must be of type string. Received type number".
    // This tells Next.js to leave these packages alone and let Node require()
    // them for real at runtime, the same way react-pdf's own docs prescribe.
    serverComponentsExternalPackages: ['@react-pdf/renderer', 'dejavu-fonts-ttf'],
  },
};
