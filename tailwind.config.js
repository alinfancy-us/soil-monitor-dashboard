/** @type {import('tailwindcss').Config} */
// 中文：Tailwind 构建期配置（取代 CDN 运行时脚本）。
//       扫描 index.html 与 page/js/**/*.js 的源码文本——app.js 动态生成的类名
//       均为字面量字符串（模板串内 ${} 只插值数值，不拼类名），文本扫描可完整覆盖。
//       index.html / page/js 的类名有变更后必须重跑 ./build_css.sh，否则新样式不生效。
module.exports = {
  content: ["./index.html", "./page/js/**/*.js"],
  theme: {
    extend: {},
  },
  plugins: [],
};
