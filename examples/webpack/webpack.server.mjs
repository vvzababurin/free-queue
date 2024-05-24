import path from 'path';

const __dirname = './public';

export default {
  devServer: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin"
    },
    hot: false,
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    compress: true,
    port: 7355,
  },
  watchOptions: {
    ignored: /node_modules/,
  },
};
