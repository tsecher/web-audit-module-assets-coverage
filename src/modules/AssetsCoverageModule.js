import {AbstractPuppeteerJourneyModule} from 'web_audit/dist/journey/AbstractPuppeteerJourneyModule.js';
import {PuppeteerJourneyEvents} from 'web_audit/dist/journey/AbstractPuppeteerJourney.js';
import {ModuleEvents} from 'web_audit/dist/modules/ModuleInterface.js';

/**
 * W3c Validator Module events.
 */
export const AssetsCoverageModuleEvents = {
	createAssetsCoverageModule: 'assets_coverage_module__createAssetsCoverageModule',
	beforeAnalyse: 'assets_coverage_module__beforeAnalyse',
	onResult: 'assets_coverage_module__onResult',
	onResultDetail: 'assets_coverage_module__onResultDetail',
	afterAnalyse: 'assets_coverage_module__afterAnalyse',
};

/**
 * W3c Validator.
 */
export default class AssetsCoverageModule extends AbstractPuppeteerJourneyModule {
	get name() {
		return 'Assets Coverage';
	}

	get id() {
		return `assets_coverage`;
	}

	defaultOptions = {};
	contextsData = {};

	/**
	 * {@inheritdoc}
	 */
	async init(context) {
		this.context = context;
		// Install assets coverage store.
		this.context.config.storage?.installStore('assets_coverage', this.context, {
			url: 'Url',
			context: 'Context',
			js: 'Unused JS rate',
			css: 'Unused CSS rate',
			files: 'Unused files',
			total: 'Total unused assets rate',
		});
		// Install assets coverage store.
		this.context.config.storage?.installStore('assets_coverage_detail', this.context, {
			url: 'Url',
			context: 'Context',
			type: 'Type',
			file: 'File',
			total: 'Total',
			used: 'Used',
			ranges: 'Ranges',
		});
		// Emit.
		this.context.eventBus.emit(AssetsCoverageModuleEvents.createAssetsCoverageModule, {module: this});
	}

	/**
	 * {@inheritdoc}
	 */
	initEvents(journey) {
		journey.on(PuppeteerJourneyEvents.JOURNEY_START, async (data) => {
			await Promise.all([
				data.wrapper.page.coverage.startJSCoverage(),
				data.wrapper.page.coverage.startCSSCoverage(),
			]);
		});
		journey.on(PuppeteerJourneyEvents.JOURNEY_NEW_CONTEXT, async (data) => {
			const [jsCoverage, cssCoverage] = await Promise.all([
				data.wrapper.page.coverage.stopJSCoverage(),
				data.wrapper.page.coverage.stopCSSCoverage(),
			]);
			this.contextsData[data.name] = {
				js: jsCoverage,
				css: cssCoverage,
			};
		});
	}

	/**
	 * {@inheritdoc}
	 */
	async analyse(urlWrapper) {
		this.context?.eventBus.emit(ModuleEvents.startsComputing, {module: this});
		for (const contextName in this.contextsData) {
			if (contextName) {
				await this.analyseContext(contextName, urlWrapper);
			}
		}
		this.context?.eventBus.emit(ModuleEvents.endsComputing, {module: this});
		return true;
	}

	/**
	 * Analyse a context.
	 *
	 * @param {string} contextName
	 * @param {UrlWrapper} urlWrapper
	 */
	async analyseContext(contextName, urlWrapper) {
		const eventData = {
			module: this,
			url: urlWrapper,
		};
		this.context?.eventBus.emit(AssetsCoverageModuleEvents.beforeAnalyse, eventData);
		this.context?.eventBus.emit(ModuleEvents.beforeAnalyse, eventData);
		const results = {
			js: {
				total: 0,
				used: 0,
				unusedRatio: 0,
				files: 0,
			},
			css: {
				total: 0,
				used: 0,
				unusedRatio: 0,
				files: 0,
			},
			all: {
				total: 0,
				used: 0,
				unusedRatio: 0,
			},
		};
		Object.keys(results).forEach((type) => {
			if (!this.contextsData[contextName][type]) {
				return;
			}
			for (const entry of this.contextsData[contextName][type]) {
				results[type].total += entry.text.length;
				results.all.total += results[type].total;
				const ranges = this.getAssetUsedRanges(entry);
				results[type].used += ranges.used;
				results.all.used += results[type].used;
				if (results[type].used === 0) {
					results[type].files++;
				}
				eventData.result = {
					url: urlWrapper.url.toString(),
					context: contextName,
					type: type,
					file: entry.url,
					total: entry.text.length,
					used: ranges.used,
					ranges: ranges.details,
				};

				this.context?.eventBus.emit(AssetsCoverageModuleEvents.onResultDetail, eventData.result);
				this.context?.config.storage.add('assets_coverage_detail', this.context, eventData.result);
			}
		});
		// Compute ratio.
		Object.values(results).forEach((result) => {
			result.unusedRatio = result.used / result.total;
		});
		// Summary.
		eventData.result = {
			url: urlWrapper.url.toString(),
			context: contextName,
			js: 1 - results.js.unusedRatio,
			css: 1 - results.css.unusedRatio,
			files: results.js.files + results.css.files,
			total: 1 - results.all.unusedRatio,
		};
		this.context?.eventBus.emit(AssetsCoverageModuleEvents.onResult, eventData);
		this.context?.config?.logger.result(`Assets coverage`, eventData.result, urlWrapper.url.toString());
		this.context?.config?.storage?.add('assets_coverage', this.context, eventData.result);
		this.context?.eventBus.emit(ModuleEvents.afterAnalyse, eventData);
		this.context?.eventBus.emit(AssetsCoverageModuleEvents.afterAnalyse, eventData);
	}

	getAssetUsedRanges(entry) {
		const detail = {
			used: 0,
			details: [],
		}
		for (const range of entry.ranges) {
			detail.used += range.end - range.start - 1;
			detail.details.push(range);
		}

		detail.details = this.getUnusedBounds(AssetsCoverageModule.cleanRangesBound(detail.details))
			.map(item => JSON.stringify(Object.values(item)));

		return detail;
	}

	static cleanRangesBound(ranges) {
		ranges.sort((a, b) => a.start - b.start);
		let bounds = ranges;
		let changes = false;
		do {
			for (let i = bounds.length - 1; i > 0; i--) {
				const current = bounds[i];
				const previous = bounds[i - 1];

				// Current is included in previous.
				if (AssetsCoverageModule.isTotalIncluded(current, previous)) {
					delete bounds[i];
					changes = true;
				} else if (AssetsCoverageModule.isPartialInclude(current, previous)) {
					// Collapse ranges.
					delete bounds[i];
					bounds[i - 1] = {
						start: previous.start,
						end: current.end,
					}
					changes = true;
				}
			}

			changes = false

			// Filter deleted.
			bounds = bounds.filter(item => item);
		}
		while (changes);

		return bounds;
	}


	static isTotalIncluded(current, previous) {
		// Collapse.
		if (previous.end > current.start || previous.end === current.start || previous.end + 1 === current.start) {
			// Previous includes current.
			return current.end <= previous.end
		}

		return false;
	}

	static isPartialInclude(current, previous) {
		// Collapse.
		if (previous.end > current.start || previous.end === current.start || previous.end + 1 === current.start) {
			// Previous includes current.
			return current.end > previous.end
		}
		return false;
	}

	getUnusedBounds(bounds) {
		const unusedBounds = [];
		if (bounds[0] && bounds[0].start > 0) {
			unusedBounds.push({
				start: 0,
				end: bounds[0].start,
			});
		}
		for (let i = 0; i < bounds.length - 2; i++) {
			if (!bounds[i + 1]) {
				console.log(bounds[i + 1]);
				process.exit();
			}
			unusedBounds.push({
				start: bounds[i].end,
				end: bounds[i + 1].start,
			});
		}

		return unusedBounds;
	}

	static async getAllExtracts(url, bounds) {
		const response = await fetch(url);
		const data = await response.text();

		const unusedPart = [];
		bounds.forEach(bound => {
			unusedPart.push(AssetsCoverageModule.getExtract(data, bound));
		});
		return unusedPart;
	}

	static getExtract(text, bound) {
		return text.slice(bound.start, bound.end);
	}
}
