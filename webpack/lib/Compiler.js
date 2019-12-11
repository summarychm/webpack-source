/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

const path = require("path");
const asyncLib = require("neo-async"); // 并行执行异步任务
const util = require("util");
const { Tapable, SyncHook, SyncBailHook, AsyncParallelHook, AsyncSeriesHook } = require("tapable");
const parseJson = require("json-parse-better-errors");
const { Source } = require("webpack-sources");

const Compilation = require("./Compilation");
const Stats = require("./Stats");
const Watching = require("./Watching");
const NormalModuleFactory = require("./NormalModuleFactory");
const ContextModuleFactory = require("./ContextModuleFactory");
const ResolverFactory = require("./ResolverFactory");

const RequestShortener = require("./RequestShortener");
const { makePathsRelative } = require("./util/identifier");
const ConcurrentCompilationError = require("./ConcurrentCompilationError");

/** @typedef {import("../declarations/WebpackOptions").Entry} Entry */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} WebpackOptions */

/** 编译器类
 * @typedef {Object} CompilationParams
 * @property {NormalModuleFactory} normalModuleFactory
 * @property {ContextModuleFactory} contextModuleFactory
 * @property {Set<string>} compilationDependencies
 */
class Compiler extends Tapable {
	constructor(context) {
		super();
		this.hooks = {
			/** webpack流程全部完成 @type {AsyncSeriesHook<Stats>} */
			done: new AsyncSeriesHook(["stats"]),
			/**  @type {AsyncSeriesHook<>} */
			additionalPass: new AsyncSeriesHook([]),
			/** @type {AsyncSeriesHook<Compiler>} */
			beforeRun: new AsyncSeriesHook(["compiler"]),
			/** @type {AsyncSeriesHook<Compiler>} */
			run: new AsyncSeriesHook(["compiler"]),

			/** 将要emit @type {SyncBailHook<Compilation>} */
			shouldEmit: new SyncBailHook(["compilation"]),
			/** @type {AsyncSeriesHook<Compilation>} */
			emit: new AsyncSeriesHook(["compilation"]),
			/** @type {AsyncSeriesHook<Compilation>} */
			afterEmit: new AsyncSeriesHook(["compilation"]),

			/** loader内部的compilation钩子 @type {SyncHook<Compilation, CompilationParams>} */
			thisCompilation: new SyncHook(["compilation", "params"]),
			/** compiler对象上的compilation钩子 @type {SyncHook<Compilation, CompilationParams>} */
			compilation: new SyncHook(["compilation", "params"]),
			/** @type {SyncHook<NormalModuleFactory>} */
			normalModuleFactory: new SyncHook(["normalModuleFactory"]),
			/** @type {SyncHook<ContextModuleFactory>}  */
			contextModuleFactory: new SyncHook(["contextModulefactory"]),

			/** 编译前 @type {AsyncSeriesHook<CompilationParams>} */
			beforeCompile: new AsyncSeriesHook(["params"]),
			/** 编译 @type {SyncHook<CompilationParams>} */
			compile: new SyncHook(["params"]),
			/** @type {AsyncParallelHook<Compilation>} */
			make: new AsyncParallelHook(["compilation"]),
			/** @type {AsyncSeriesHook<Compilation>} */
			afterCompile: new AsyncSeriesHook(["compilation"]),

			/** @type {AsyncSeriesHook<Compiler>} */
			watchRun: new AsyncSeriesHook(["compiler"]),
			/** @type {SyncHook<Error>} */
			failed: new SyncHook(["error"]),
			/** @type {SyncHook<string, string>} */
			invalid: new SyncHook(["filename", "changeTime"]),
			/** @type {SyncHook} */
			watchClose: new SyncHook([]),

			// TODO the following hooks are weirdly located here
			// TODO move them for webpack 5
			/** @type {SyncHook} */
			environment: new SyncHook([]),
			/** @type {SyncHook} */
			afterEnvironment: new SyncHook([]),
			/** @type {SyncHook<Compiler>} */
			afterPlugins: new SyncHook(["compiler"]),
			/** @type {SyncHook<Compiler>} */
			afterResolvers: new SyncHook(["compiler"]),
			/** 初始化options钩子 @type {SyncBailHook<string, Entry>} */
			entryOption: new SyncBailHook(["context", "entry"]),
		};

		this._pluginCompat.tap("Compiler", (options) => {
			switch (options.name) {
				case "additional-pass":
				case "before-run":
				case "run":
				case "emit":
				case "after-emit":
				case "before-compile":
				case "make":
				case "after-compile":
				case "watch-run":
					options.async = true;
					break;
			}
		});

		/** @type {string=} */
		this.name = undefined;
		/** @type {Compilation=} */
		this.parentCompilation = undefined;
		/** @type {string} */
		this.outputPath = "";

		this.outputFileSystem = null;
		this.inputFileSystem = null;

		/** @type {string|null} */
		this.recordsInputPath = null;
		/** @type {string|null} */
		this.recordsOutputPath = null;
		this.records = {};
		this.removedFiles = new Set();
		/** @type {Map<string, number>} */
		this.fileTimestamps = new Map();
		/** @type {Map<string, number>} */
		this.contextTimestamps = new Map();
		/** @type {ResolverFactory} */
		this.resolverFactory = new ResolverFactory();

		// TODO remove in webpack 5
		this.resolvers = {
			normal: {
				plugins: util.deprecate((hook, fn) => {
					this.resolverFactory.plugin("resolver normal", (resolver) => {
						resolver.plugin(hook, fn);
					});
				}, "webpack: Using compiler.resolvers.normal is deprecated.\n" + 'Use compiler.resolverFactory.plugin("resolver normal", resolver => {\n  resolver.plugin(/* … */);\n}); instead.'),
				apply: util.deprecate((...args) => {
					this.resolverFactory.plugin("resolver normal", (resolver) => {
						resolver.apply(...args);
					});
				}, "webpack: Using compiler.resolvers.normal is deprecated.\n" + 'Use compiler.resolverFactory.plugin("resolver normal", resolver => {\n  resolver.apply(/* … */);\n}); instead.'),
			},
			loader: {
				plugins: util.deprecate((hook, fn) => {
					this.resolverFactory.plugin("resolver loader", (resolver) => {
						resolver.plugin(hook, fn);
					});
				}, "webpack: Using compiler.resolvers.loader is deprecated.\n" + 'Use compiler.resolverFactory.plugin("resolver loader", resolver => {\n  resolver.plugin(/* … */);\n}); instead.'),
				apply: util.deprecate((...args) => {
					this.resolverFactory.plugin("resolver loader", (resolver) => {
						resolver.apply(...args);
					});
				}, "webpack: Using compiler.resolvers.loader is deprecated.\n" + 'Use compiler.resolverFactory.plugin("resolver loader", resolver => {\n  resolver.apply(/* … */);\n}); instead.'),
			},
			context: {
				plugins: util.deprecate((hook, fn) => {
					this.resolverFactory.plugin("resolver context", (resolver) => {
						resolver.plugin(hook, fn);
					});
				}, "webpack: Using compiler.resolvers.context is deprecated.\n" + 'Use compiler.resolverFactory.plugin("resolver context", resolver => {\n  resolver.plugin(/* … */);\n}); instead.'),
				apply: util.deprecate((...args) => {
					this.resolverFactory.plugin("resolver context", (resolver) => {
						resolver.apply(...args);
					});
				}, "webpack: Using compiler.resolvers.context is deprecated.\n" + 'Use compiler.resolverFactory.plugin("resolver context", resolver => {\n  resolver.apply(/* … */);\n}); instead.'),
			},
		};

		/** @type {WebpackOptions} */
		this.options = /** @type {WebpackOptions} */ ({});

		this.context = context;

		this.requestShortener = new RequestShortener(context);

		/** @type {boolean} */
		this.running = false;

		/** @type {boolean} */
		this.watchMode = false;

		/** 记录资源在不同目标路径被写入的次数。 @private @type {WeakMap<Source, { sizeOnlySource: SizeOnlySource, writtenTo: Map<string, number> }>} */
		this._assetEmittingSourceCache = new WeakMap();
		/** 目标路径被写入的次数，{targetPath:count} @private @type {Map<string, number>} */
		this._assetEmittingWrittenFiles = new Map();
	}

	watch(watchOptions, handler) {
		if (this.running) return handler(new ConcurrentCompilationError());

		this.running = true;
		this.watchMode = true;
		this.fileTimestamps = new Map();
		this.contextTimestamps = new Map();
		this.removedFiles = new Set();
		return new Watching(this, watchOptions, handler);
	}
	/** 开始执行构建 */
	run(callback) {
		// 如果编译正在进行，抛出错误（一个webpack实例不能同时进行多次编译）
		if (this.running) return callback(new ConcurrentCompilationError());
		// 定义构建结束回调
		const finalCallback = (err, stats) => {
			this.running = false;

			// 若有错误,则执行failed钩子上的回调.
			// 可以通过compiler.hooks.failed.tap()挂载回调函数.
			if (err) this.hooks.failed.call(err);
			if (callback !== undefined) return callback(err, stats);
		};

		const startTime = Date.now();
		// 标记开始构建
		this.running = true;

		// 定义compiler回调函数
		const onCompiled = (err, compilation) => {
			if (err) return finalCallback(err);
			// hooks: 执行shouldEmit回调,如果返回false则不输出构建资源
			if (this.hooks.shouldEmit.call(compilation) === false) {
				// stats包含了本次构建中的一些数据信息
				const stats = new Stats(compilation);
				stats.startTime = startTime;
				stats.endTime = Date.now();
				// hooks: 执行done回调,并传入stats
				this.hooks.done.callAsync(stats, (err) => {
					if (err) return finalCallback(err);
					return finalCallback(null, stats);
				});
				return;
			}
			// 调用compiler.emitAssets输出构建资源
			this.emitAssets(compilation, (err) => {
				if (err) return finalCallback(err);
				// hooks 判断资源是否需要进一步处理
				if (compilation.hooks.needAdditionalPass.call()) {
					compilation.needAdditionalPass = true;

					const stats = new Stats(compilation);
					stats.startTime = startTime;
					stats.endTime = Date.now();
					// hooks: 执行done回调
					this.hooks.done.callAsync(stats, (err) => {
						if (err) return finalCallback(err);
						// hooks: 执行additionPass回调
						this.hooks.additionalPass.callAsync((err) => {
							if (err) return finalCallback(err);
							// 再次compile
							this.compile(onCompiled);
						});
					});
					return;
				}
				// 输出records
				this.emitRecords((err) => {
					if (err) return finalCallback(err);

					const stats = new Stats(compilation);
					stats.startTime = startTime;
					stats.endTime = Date.now();
					// hooks: 执行done回调
					this.hooks.done.callAsync(stats, (err) => {
						if (err) return finalCallback(err);
						return finalCallback(null, stats);
					});
				});
			});
		};
		// hooks: 执行beforeRun回调
		this.hooks.beforeRun.callAsync(this, (err) => {
			if (err) return finalCallback(err);
			// hooks: 执行run回调
			this.hooks.run.callAsync(this, (err) => {
				if (err) return finalCallback(err);
				// 读取之前的构建记录
				this.readRecords((err) => {
					if (err) return finalCallback(err);
					//! 开始编译
					this.compile(onCompiled);
				});
			});
		});
	}

	runAsChild(callback) {
		this.compile((err, compilation) => {
			if (err) return callback(err);

			this.parentCompilation.children.push(compilation);
			for (const name of Object.keys(compilation.assets)) {
				this.parentCompilation.assets[name] = compilation.assets[name];
			}

			const entries = Array.from(compilation.entrypoints.values(), (ep) => ep.chunks).reduce((array, chunks) => {
				return array.concat(chunks);
			}, []);

			return callback(null, entries, compilation);
		});
	}

	purgeInputFileSystem() {
		if (this.inputFileSystem && this.inputFileSystem.purge) {
			this.inputFileSystem.purge();
		}
	}
	/** 输出构建资源 */
	emitAssets(compilation, callback) {
		let outputPath;
		// 输出打包结果的方法
		const emitFiles = (err) => {
			if (err) return callback(err);
			// 异步的forEach方法
			asyncLib.forEachLimit(
				compilation.assets,
				15, //最多并行15个异步任务
				(source, file, callback) => {
					let targetFile = file;
					const queryStringIdx = targetFile.indexOf("?");
					if (queryStringIdx >= 0) targetFile = targetFile.substr(0, queryStringIdx);

					// 执行写文件操作
					const writeOut = (err) => {
						if (err) return callback(err);
						// 解析出真实的目标路径
						const targetPath = this.outputFileSystem.join(outputPath, targetFile);
						// TODO webpack 5 remove futureEmitAssets option and make it on by default
						if (this.options.output.futureEmitAssets) {
							// 检测目标文件是否已经被Compiler写入过
							const targetFileGeneration = this._assetEmittingWrittenFiles.get(targetPath);

							// 若cacheEntry不存在,则为当前source创建一个
							let cacheEntry = this._assetEmittingSourceCache.get(source);
							if (cacheEntry === undefined) {
								cacheEntry = {
									sizeOnlySource: undefined,
									writtenTo: new Map(),
									// 存储资源被写入的目标路径及其次数，
									// 对应this._assetEmittingWrittenFiles 的格式
								};
								this._assetEmittingSourceCache.set(source, cacheEntry);
							}

							// 如果目标文件已经被写入过
							if (targetFileGeneration !== undefined) {
								// 检查source是否被写到了目标文件路径
								const writtenGeneration = cacheEntry.writtenTo.get(targetPath);
								if (writtenGeneration === targetFileGeneration) {
									// 如果写入过则跳过,(我们假设Compiler在running过程中文件不会被删除)
									return callback();
								}
							}

							/** source的二进制内容 @type {Buffer} */
							let content;
							if (typeof source.buffer === "function") {
								content = source.buffer();
							} else {
								const bufferOrString = source.source();
								if (Buffer.isBuffer(bufferOrString)) {
									content = bufferOrString;
								} else {
									content = Buffer.from(bufferOrString, "utf8");
								}
							}

							// 创建一个source的代替资源，其只有一个size方法返回size属性（sizeOnlySource）
							// 这步操作是为了让垃圾回收机制能回收由source创建的内存资源
							// 这里是设置了output.futureEmitAssets = true时，assets的内存资源会被释放的原因
							cacheEntry.sizeOnlySource = new SizeOnlySource(content.length);
							compilation.assets[file] = cacheEntry.sizeOnlySource;

							// 将content写到目标路径targetPath
							this.outputFileSystem.writeFile(targetPath, content, (err) => {
								if (err) return callback(err);

								// 缓存source已经被写入目标路径，写入次数自增
								compilation.emittedAssets.add(file);

								// 将这个自增的值写入cacheEntry.writtenTo和this._assetEmittingWrittenFiles两个Map中
								const newGeneration = targetFileGeneration === undefined ? 1 : targetFileGeneration + 1;
								cacheEntry.writtenTo.set(targetPath, newGeneration);
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);
								callback();
							});
						} else {
							// 若资源已存在在目标路径 则跳过
							if (source.existsAt === targetPath) {
								source.emitted = false;
								return callback();
							}
							// 获取资源内容
							let content = source.source();

							if (!Buffer.isBuffer(content)) {
								content = Buffer.from(content, "utf8");
							}
							// 写入目标路径并标记
							source.existsAt = targetPath;
							source.emitted = true;
							this.outputFileSystem.writeFile(targetPath, content, callback);
						}
					};
					// 若目标文件路径包含"/"或"\",先创建文件夹再写入
					if (targetFile.match(/\/|\\/)) {
						const dir = path.dirname(targetFile);
						this.outputFileSystem.mkdirp(this.outputFileSystem.join(outputPath, dir), writeOut);
					} else {
						writeOut();
					}
				},
				(err) => {
					if (err) return callback(err);
					// hooks: 执行afterEmit回调
					this.hooks.afterEmit.callAsync(compilation, (err) => {
						if (err) return callback(err);

						return callback();
					});
				},
			);
		};
		// hooks: 执行emit回调
		this.hooks.emit.callAsync(compilation, (err) => {
			if (err) return callback(err);
			// 获取输出路径
			outputPath = compilation.getPath(this.outputPath);
			// 递归创建输出目录,并输出资源
			this.outputFileSystem.mkdirp(outputPath, emitFiles);
		});
	}
	/** 输出本次构建记录 */
	emitRecords(callback) {
		if (!this.recordsOutputPath) return callback();
		const idx1 = this.recordsOutputPath.lastIndexOf("/");
		const idx2 = this.recordsOutputPath.lastIndexOf("\\");
		let recordsOutputPathDirectory = null;
		if (idx1 > idx2) {
			recordsOutputPathDirectory = this.recordsOutputPath.substr(0, idx1);
		} else if (idx1 < idx2) {
			recordsOutputPathDirectory = this.recordsOutputPath.substr(0, idx2);
		}

		const writeFile = () => {
			this.outputFileSystem.writeFile(this.recordsOutputPath, JSON.stringify(this.records, undefined, 2), callback);
		};

		if (!recordsOutputPathDirectory) {
			return writeFile();
		}
		this.outputFileSystem.mkdirp(recordsOutputPathDirectory, (err) => {
			if (err) return callback(err);
			writeFile();
		});
	}
	/** 读取之前的构建记录(存储多次构建过程中的module标识) */
	readRecords(callback) {
		// 上一组records的文件路径,不存在则说明没有构建记录.
		if (!this.recordsInputPath) {
			this.records = {};
			return callback();
		}
		// 增强版fs,读取并缓存到this.records中
		this.inputFileSystem.stat(this.recordsInputPath, (err) => {
			// It doesn't exist
			// We can ignore this.
			if (err) return callback();

			this.inputFileSystem.readFile(this.recordsInputPath, (err, content) => {
				if (err) return callback(err);

				try {
					this.records = parseJson(content.toString("utf-8"));
				} catch (e) {
					e.message = "Cannot parse records: " + e.message;
					return callback(e);
				}

				return callback();
			});
		});
	}

	createChildCompiler(compilation, compilerName, compilerIndex, outputOptions, plugins) {
		const childCompiler = new Compiler(this.context);
		if (Array.isArray(plugins)) {
			for (const plugin of plugins) {
				plugin.apply(childCompiler);
			}
		}
		for (const name in this.hooks) {
			if (!["make", "compile", "emit", "afterEmit", "invalid", "done", "thisCompilation"].includes(name)) {
				if (childCompiler.hooks[name]) {
					childCompiler.hooks[name].taps = this.hooks[name].taps.slice();
				}
			}
		}
		childCompiler.name = compilerName;
		childCompiler.outputPath = this.outputPath;
		childCompiler.inputFileSystem = this.inputFileSystem;
		childCompiler.outputFileSystem = null;
		childCompiler.resolverFactory = this.resolverFactory;
		childCompiler.fileTimestamps = this.fileTimestamps;
		childCompiler.contextTimestamps = this.contextTimestamps;

		const relativeCompilerName = makePathsRelative(this.context, compilerName);
		if (!this.records[relativeCompilerName]) {
			this.records[relativeCompilerName] = [];
		}
		if (this.records[relativeCompilerName][compilerIndex]) {
			childCompiler.records = this.records[relativeCompilerName][compilerIndex];
		} else {
			this.records[relativeCompilerName].push((childCompiler.records = {}));
		}

		childCompiler.options = Object.create(this.options);
		childCompiler.options.output = Object.create(childCompiler.options.output);
		for (const name in outputOptions) {
			childCompiler.options.output[name] = outputOptions[name];
		}
		childCompiler.parentCompilation = compilation;

		compilation.hooks.childCompiler.call(childCompiler, compilerName, compilerIndex);

		return childCompiler;
	}

	isChild() {
		return !!this.parentCompilation;
	}
	/** 创建新的Compilation实例 */
	createCompilation() {
		return new Compilation(this);
	}
	/** 创建新的Compilation */
	newCompilation(params) {
		const compilation = this.createCompilation();
		compilation.fileTimestamps = this.fileTimestamps;
		compilation.contextTimestamps = this.contextTimestamps;
		compilation.name = this.name;
		compilation.records = this.records;
		compilation.compilationDependencies = params.compilationDependencies;
		this.hooks.thisCompilation.call(compilation, params);
		this.hooks.compilation.call(compilation, params);
		return compilation;
	}

	createNormalModuleFactory() {
		const normalModuleFactory = new NormalModuleFactory(this.options.context, this.resolverFactory, this.options.module || {});
		this.hooks.normalModuleFactory.call(normalModuleFactory);
		return normalModuleFactory;
	}

	createContextModuleFactory() {
		const contextModuleFactory = new ContextModuleFactory(this.resolverFactory);
		this.hooks.contextModuleFactory.call(contextModuleFactory);
		return contextModuleFactory;
	}

	/** 构建创建Compilation初始参数(新建NormalModule和ContextModule工厂实例)  */
	newCompilationParams() {
		const params = {
			normalModuleFactory: this.createNormalModuleFactory(),
			contextModuleFactory: this.createContextModuleFactory(),
			compilationDependencies: new Set(),
		};
		return params;
	}
	/** 正式编译 */
	compile(callback) {
		// 构建创建Compilation初始参数
		const params = this.newCompilationParams();
		// hooks: 执行beforeCompile回调
		this.hooks.beforeCompile.callAsync(params, (err) => {
			if (err) return callback(err);
			// hooks: 执行compile回调
			this.hooks.compile.call(params);
			//! 创建一个新的compilation对象
			const compilation = this.newCompilation(params);
			// hooks: 执行make回调
			this.hooks.make.callAsync(compilation, (err) => {
				if (err) return callback(err);
				// 模块处理完毕
				compilation.finish((err) => {
					if (err) return callback(err);
					// 进入封装阶段,封装完成即代表构建完成
					compilation.seal((err) => {
						if (err) return callback(err);
						// hooks: 执行afterCompile回调
						this.hooks.afterCompile.callAsync(compilation, (err) => {
							if (err) return callback(err);
							// 执行run函数定义的onCompiled回调,将本次的compilation传入
							return callback(null, compilation);
						});
					});
				});
			});
		});
	}
}

module.exports = Compiler;

class SizeOnlySource extends Source {
	constructor(size) {
		super();
		this._size = size;
	}

	_error() {
		return new Error("Content and Map of this Source is no longer available (only size() is supported)");
	}

	size() {
		return this._size;
	}

	/**
	 * @param {any} options options
	 * @returns {string} the source
	 */
	source(options) {
		throw this._error();
	}

	node() {
		throw this._error();
	}

	listMap() {
		throw this._error();
	}

	map() {
		throw this._error();
	}

	listNode() {
		throw this._error();
	}

	updateHash() {
		throw this._error();
	}
}
