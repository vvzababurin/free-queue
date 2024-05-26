import path from 'path';
import webpack from 'webpack';

import HtmlWebpackPlugin from 'html-webpack-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import RemoveWebpackPlugin from 'remove-files-webpack-plugin';

const __dirname = './';

export default {
    entry: [ 'babel-polyfill', './src/app.mjs' ],
    experiments: {
        topLevelAwait: true
    },

    performance: {
      hints: false,
      maxEntrypointSize: 512000,
      maxAssetSize: 512000
    },
    plugins: [
      new HtmlWebpackPlugin({ 
        title: 'WebGPU Test Page',
        filename: 'index.html',
        template: './src/index.template'
      }),
      new RemoveWebpackPlugin({
        before: {
          log: false,
          include: [ 'dist' ]
        }
      }),
      new CopyWebpackPlugin({ 
	      patterns: [
//          { from: path.resolve(__dirname, 'src', 'fonts'), to: path.resolve(__dirname, 'dist', 'fonts') },
          { from: path.resolve(__dirname, 'src', 'js'), to: path.resolve(__dirname, 'dist', 'js') }
//          { from: path.resolve(__dirname, 'src', 'assets'), to: path.resolve(__dirname, 'dist', 'assets') },
//          { from: path.resolve(__dirname, 'src', 'addons'), to: path.resolve(__dirname, 'dist') },
//          { from: path.resolve(__dirname, 'src', 'config'), to: path.resolve(__dirname, 'dist', 'config') },
//          { from: path.resolve(__dirname, 'src', 'sounds'), to: path.resolve(__dirname, 'dist', 'sounds') }
        ]
      })
    ],
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: "[name].bundle.js",
	    chunkFilename: "[id].bundle.js",
	    assetModuleFilename: "[path][name].[ext]",
    // publicPath: path.resolve(__dirname, 'dist/this'),
    },
    module: {
      rules: [{
        test: /\.html$/,
        loader: "raw-loader"
      },
      { 
	      test: /\.(jsx|mjs)$/, 
        exclude: /\.(node_modules|js)$/,
        use: { 
          loader: 'babel-loader',  
          options: {
            presets: ['@babel/preset-env']
          } 
        },
      },
      { 
        test: /\.wgsl/,
        type: 'asset/source'
      },
      { 
        test: /\.(eot|svg|ttf|woff|woff2)$/,
        type: 'asset/resource',
        generator: {
          filename: '[path][name].[ext]'
        }
      }]
    }
};
