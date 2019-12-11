// 不需要进行构建的命令集合
const NON_COMPILATION_ARGS = [
	"init", // 创建一份
	"migrate", // 进行 webpack 版本迁移
	"add", // 往 webpack 配置文件中增加属性
	"remove", // 往 webpack 配置文件中删除属性
	"serve", // 运行 webpack-serve
	"generate-loader", // 生成 webpack loader 代码 webpack-cli generate-loader
	"generate-plugin", // 生成 webpack plugin 代码
	"info", // 返回与本地环境相关的一些信息
];

// command分组信息
const CONFIG_GROUP = "Config options:";
const BASIC_GROUP = "Basic options:";
const MODULE_GROUP = "Module options:";
const OUTPUT_GROUP = "Output options:";
const ADVANCED_GROUP = "Advanced options:";
const RESOLVE_GROUP = "Resolving options:";
const OPTIMIZE_GROUP = "Optimizing options:";
const DISPLAY_GROUP = "Stats options:";
const GROUPS = {
	CONFIG_GROUP,
	BASIC_GROUP,
	MODULE_GROUP,
	OUTPUT_GROUP,
	ADVANCED_GROUP,
	RESOLVE_GROUP,
	OPTIMIZE_GROUP,
	DISPLAY_GROUP,
};

const WEBPACK_OPTIONS_FLAG = "WEBPACK_OPTIONS";

module.exports = {
	NON_COMPILATION_ARGS,
	GROUPS,
	WEBPACK_OPTIONS_FLAG,
};
