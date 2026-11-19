import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import {
	jsonParse,
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
} from 'n8n-workflow';

import {
	buildMediaInput,
	extractUrls,
	fetchMediaModels,
	fetchTextModels,
	formatMediaPrice,
	megaBrainApiRequest,
	splitUrls,
	type MediaModel,
} from './GenericFunctions';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '4:5', '5:4'];

const waitFields = (resource: string, defaultTimeout: number): INodeProperties[] => [
	{
		displayName: 'Wait for Result',
		name: 'waitForResult',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [resource], operation: ['generate'] } },
		description:
			'Whether to wait until the job finishes and return the file URL. Turn off to return the job ID right away and fetch the result later with Job → Get Result.',
	},
	{
		displayName: 'Download File',
		name: 'download',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: { resource: [resource], operation: ['generate'], waitForResult: [true] },
		},
		description: 'Whether to download the generated file into the binary data of the item',
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		displayOptions: {
			show: {
				resource: [resource],
				operation: ['generate'],
				waitForResult: [true],
				download: [true],
			},
		},
		hint: 'The name of the output binary field to put the file in',
	},
	{
		displayName: 'Timeout (Seconds)',
		name: 'timeout',
		type: 'number',
		typeOptions: { minValue: 10 },
		default: defaultTimeout,
		displayOptions: {
			show: { resource: [resource], operation: ['generate'], waitForResult: [true] },
		},
		description: 'How long to wait for the job before giving up (the job keeps running)',
	},
];

const extraParameters = (resource: string): INodeProperties => ({
	displayName: 'Extra Parameters (JSON)',
	name: 'extraParameters',
	type: 'json',
	default: '{}',
	description:
		'Any other model fields, sent as is. Every model’s fields are listed at https://getmegabrain.com/docs/media#params.',
	displayOptions: { show: { resource: [resource], operation: ['generate'] } },
});

export class MegaBrain implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MegaBrain',
		name: 'megaBrain',
		icon: { light: 'file:megabrain.svg', dark: 'file:megabrain.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Generate images and videos (Nano Banana Pro, FLUX 2, Kling 3, Seedance) and chat with text models through one MegaBrain API key',
		defaults: { name: 'MegaBrain' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'megaBrainApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Image', value: 'image' },
					{ name: 'Job', value: 'job' },
					{ name: 'Text', value: 'text' },
					{ name: 'Video', value: 'video' },
				],
				default: 'image',
			},

			// ----------------------------------------------------------------- operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['image'] } },
				options: [
					{
						name: 'Generate',
						value: 'generate',
						description: 'Create or edit an image from a prompt',
						action: 'Generate an image',
					},
				],
				default: 'generate',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['video'] } },
				options: [
					{
						name: 'Generate',
						value: 'generate',
						description: 'Create a video from a prompt or a start image',
						action: 'Generate a video',
					},
				],
				default: 'generate',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['text'] } },
				options: [
					{
						name: 'Message a Model',
						value: 'message',
						description: 'Send a prompt to a text model and get its answer',
						action: 'Message a model',
					},
				],
				default: 'message',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['job'] } },
				options: [
					{
						name: 'Get Result',
						value: 'getResult',
						description: 'Get the output of a finished image or video job',
						action: 'Get the result of a job',
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						description: 'Get the status of an image or video job',
						action: 'Get the status of a job',
					},
				],
				default: 'getResult',
			},

			// ----------------------------------------------------------------- image
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getImageModels' },
				default: 'nano-banana-pro',
				required: true,
				displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
				description:
					'The image model. Models ending in /edit take Image URLs to change. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['image', 'video'], operation: ['generate'] } },
				description: 'What to generate',
			},
			{
				displayName: 'Image URLs',
				name: 'imageUrls',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
				description:
					'Public URLs of images to edit or use as references, separated by commas. Only for edit models (for example nano-banana-pro/edit, flux-2/edit).',
			},
			{
				displayName: 'Options',
				name: 'imageOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
				options: [
					{
						displayName: 'Aspect Ratio',
						name: 'aspectRatio',
						type: 'options',
						options: ASPECT_RATIOS.map((ratio) => ({ name: ratio, value: ratio })),
						default: '1:1',
						description:
							'Frame shape. For models that take named sizes (FLUX) it becomes the closest size.',
					},
					{
						displayName: 'Number of Images',
						name: 'numImages',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 4 },
						default: 1,
						description: 'How many images to generate. The price is multiplied by this number.',
					},
					{
						displayName: 'Output Format',
						name: 'outputFormat',
						type: 'options',
						options: [
							{ name: 'JPEG', value: 'jpeg' },
							{ name: 'PNG', value: 'png' },
							{ name: 'WebP', value: 'webp' },
						],
						default: 'png',
					},
					{
						displayName: 'Resolution',
						name: 'resolution',
						type: 'options',
						options: [
							{ name: '1K', value: '1K' },
							{ name: '2K', value: '2K' },
							{ name: '4K', value: '4K' },
						],
						default: '1K',
						description: 'For Nano Banana models. 4K costs twice as much.',
					},
					{
						displayName: 'Seed',
						name: 'seed',
						type: 'number',
						default: 0,
						description: 'The same seed and request give the same result',
					},
				],
			},
			extraParameters('image'),
			...waitFields('image', 300),

			// ----------------------------------------------------------------- video
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getVideoModels' },
				default: 'kling-video/v3/standard/text-to-video',
				required: true,
				displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
				description:
					'The video model. Image-to-video models need a Start Image URL. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Start Image URL',
				name: 'startImageUrl',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
				description: 'Public URL of the first frame. Required for image-to-video models.',
			},
			{
				displayName: 'Duration (Seconds)',
				name: 'duration',
				type: 'number',
				typeOptions: { minValue: 3, maxValue: 30 },
				default: 5,
				displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
				description:
					'Video length. Kling 3 takes 3–15 seconds, Kling 2.6 takes 5 or 10, Seedance 4–30. The price is per second.',
			},
			{
				displayName: 'Generate Audio',
				name: 'generateAudio',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
				description: 'Whether to add a soundtrack made by the model. Costs more per second.',
			},
			{
				displayName: 'Options',
				name: 'videoOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
				options: [
					{
						displayName: 'Aspect Ratio',
						name: 'aspectRatio',
						type: 'options',
						options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((ratio) => ({
							name: ratio,
							value: ratio,
						})),
						default: '16:9',
						description: 'For models that take it (Seedance). Image-to-video follows the image.',
					},
					{
						displayName: 'End Image URL',
						name: 'endImageUrl',
						type: 'string',
						default: '',
						description: 'Public URL of the last frame, for image-to-video models that take one',
					},
					{
						displayName: 'Negative Prompt',
						name: 'negativePrompt',
						type: 'string',
						default: '',
						description: 'What the video should not have',
					},
					{
						displayName: 'Resolution',
						name: 'resolution',
						type: 'options',
						options: [
							{ name: '480p', value: '480p' },
							{ name: '720p', value: '720p' },
							{ name: '1080p', value: '1080p' },
						],
						default: '720p',
						description: 'For Seedance models',
					},
					{
						displayName: 'Seed',
						name: 'seed',
						type: 'number',
						default: 0,
					},
				],
			},
			extraParameters('video'),
			...waitFields('video', 900),

			// ----------------------------------------------------------------- text
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTextModels' },
				default: 'mb-auto/free',
				required: true,
				displayOptions: { show: { resource: ['text'], operation: ['message'] } },
				description:
					'The text model. Auto Free (mb-auto/free) costs nothing. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['text'], operation: ['message'] } },
				description: 'The user message',
			},
			{
				displayName: 'Simplify Output',
				name: 'simplify',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['text'], operation: ['message'] } },
				description:
					'Whether to return only the answer, model and usage instead of the full response',
			},
			{
				displayName: 'Options',
				name: 'textOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['text'], operation: ['message'] } },
				options: [
					{
						displayName: 'JSON Output',
						name: 'jsonOutput',
						type: 'boolean',
						default: false,
						description:
							'Whether to ask the model for a JSON object and parse it (say "JSON" in the prompt too)',
					},
					{
						displayName: 'Maximum Tokens',
						name: 'maxTokens',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 2048,
						description: 'The longest answer to generate, in tokens',
					},
					{
						displayName: 'System Message',
						name: 'system',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						description: 'Instructions for the model that come before the prompt',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 0.7,
						description: 'Higher is more varied, lower is more focused',
					},
				],
			},

			// ----------------------------------------------------------------- job
			{
				displayName: 'Request ID',
				name: 'requestId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['job'] } },
				description: 'The request_id returned when the job was submitted',
			},
		],
	};

	methods = {
		loadOptions: {
			async getImageModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return mediaOptions(await fetchMediaModels.call(this), 'image');
			},
			async getVideoModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return mediaOptions(await fetchMediaModels.call(this), 'video');
			},
			async getTextModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const models = await fetchTextModels.call(this);
				return models.map((model) => ({
					name: model.name ? `${model.name} (${model.id})` : model.id,
					value: model.id,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		let catalog: MediaModel[] | undefined;

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'text' && operation === 'message') {
					returnData.push({ json: await messageModel.call(this, i), pairedItem: { item: i } });
					continue;
				}

				if (resource === 'job') {
					const requestId = encodeURIComponent(
						(this.getNodeParameter('requestId', i) as string).trim(),
					);
					if (operation === 'getStatus') {
						const status = await megaBrainApiRequest.call(
							this,
							'GET',
							`/queue/requests/${requestId}/status`,
						);
						returnData.push({ json: status, pairedItem: { item: i } });
					} else {
						const output = await megaBrainApiRequest.call(
							this,
							'GET',
							`/queue/requests/${requestId}`,
						);
						const urls = extractUrls(output);
						returnData.push({
							json: { request_id: decodeURIComponent(requestId), url: urls[0], urls, output },
							pairedItem: { item: i },
						});
					}
					continue;
				}

				if ((resource === 'image' || resource === 'video') && operation === 'generate') {
					if (catalog === undefined) {
						try {
							catalog = await fetchMediaModels.call(this);
						} catch {
							// The catalog only helps map fields; go on without it.
							catalog = [];
						}
					}
					returnData.push(await generateMedia.call(this, i, resource, catalog));
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					`The operation "${operation}" is not supported for "${resource}"`,
					{ itemIndex: i },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error instanceof NodeOperationError || error instanceof NodeApiError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

function mediaOptions(models: MediaModel[], kind: 'image' | 'video'): INodePropertyOptions[] {
	return models
		.filter((model) => model.kind === kind)
		.map((model) => {
			const price = formatMediaPrice(model);
			return {
				name: `${model.name} (${model.id})`,
				value: model.id,
				description: [price, model.description].filter(Boolean).join(' — '),
			};
		});
}

async function messageModel(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const model = this.getNodeParameter('model', i) as string;
	const prompt = this.getNodeParameter('prompt', i) as string;
	const simplify = this.getNodeParameter('simplify', i) as boolean;
	const options = this.getNodeParameter('textOptions', i, {}) as IDataObject;

	const messages: IDataObject[] = [];
	if (typeof options.system === 'string' && options.system.trim() !== '') {
		messages.push({ role: 'system', content: options.system });
	}
	messages.push({ role: 'user', content: prompt });

	const body: IDataObject = { model, messages };
	if (options.temperature !== undefined) body.temperature = options.temperature;
	if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
	if (options.jsonOutput === true) body.response_format = { type: 'json_object' };

	const response = await megaBrainApiRequest.call(this, 'POST', '/chat/completions', body);
	if (!simplify) return response;

	const choices = (response.choices as IDataObject[] | undefined) ?? [];
	const message = (choices[0]?.message as IDataObject | undefined) ?? {};
	let content: unknown = message.content ?? '';
	if (options.jsonOutput === true && typeof content === 'string') {
		const text = content
			.trim()
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/```$/, '')
			.trim();
		content = jsonParse(text, { fallbackValue: content });
	}
	return {
		content: content as IDataObject[keyof IDataObject],
		model: response.model,
		finish_reason: choices[0]?.finish_reason,
		usage: response.usage,
	};
}

async function generateMedia(
	this: IExecuteFunctions,
	i: number,
	resource: 'image' | 'video',
	catalog: MediaModel[],
): Promise<INodeExecutionData> {
	const modelId = (this.getNodeParameter('model', i) as string).trim();
	const prompt = this.getNodeParameter('prompt', i) as string;
	const model = catalog.find((entry) => entry.id === modelId);

	const rawExtra = this.getNodeParameter('extraParameters', i, '{}') as string | IDataObject;
	let extra: IDataObject = {};
	if (typeof rawExtra === 'string') {
		if (rawExtra.trim() !== '') {
			extra = jsonParse<IDataObject>(rawExtra, {
				errorMessage: 'Extra Parameters (JSON) is not valid JSON',
			});
		}
	} else if (rawExtra && typeof rawExtra === 'object') {
		extra = rawExtra;
	}

	let input: ReturnType<typeof buildMediaInput>;
	if (resource === 'image') {
		const options = this.getNodeParameter('imageOptions', i, {}) as IDataObject;
		input = buildMediaInput(
			model,
			{
				prompt,
				imageUrls: splitUrls(this.getNodeParameter('imageUrls', i, '') as string),
				aspectRatio: options.aspectRatio as string | undefined,
				resolution: options.resolution as string | undefined,
				numImages: options.numImages as number | undefined,
				seed: options.seed as number | undefined,
				outputFormat: options.outputFormat as string | undefined,
			},
			extra,
		);
	} else {
		const options = this.getNodeParameter('videoOptions', i, {}) as IDataObject;
		const duration = this.getNodeParameter('duration', i) as number;
		input = buildMediaInput(
			model,
			{
				prompt,
				startImageUrl: (this.getNodeParameter('startImageUrl', i, '') as string).trim(),
				endImageUrl: ((options.endImageUrl as string | undefined) ?? '').trim(),
				duration: String(Math.round(duration)),
				generateAudio: this.getNodeParameter('generateAudio', i) as boolean,
				aspectRatio: options.aspectRatio as string | undefined,
				resolution: options.resolution as string | undefined,
				negativePrompt: options.negativePrompt as string | undefined,
				seed: options.seed as number | undefined,
			},
			extra,
		);
		if (
			model?.accepts_image &&
			!('start_image_url' in input.body) &&
			!('first_frame_url' in input.body)
		) {
			throw new NodeOperationError(
				this.getNode(),
				`The model ${modelId} turns an image into a video: fill in Start Image URL`,
				{ itemIndex: i },
			);
		}
	}

	const job = await megaBrainApiRequest.call(
		this,
		'POST',
		`/queue/${modelId.split('/').map(encodeURIComponent).join('/')}`,
		input.body,
	);
	const base: IDataObject = {
		request_id: job.request_id,
		model: job.model ?? modelId,
		status: job.status,
		status_url: job.status_url,
		response_url: job.response_url,
	};
	if (input.skipped.length > 0) {
		base.skipped_options = `${modelId} does not take: ${input.skipped.join(', ')}`;
	}

	const waitForResult = this.getNodeParameter('waitForResult', i) as boolean;
	if (!waitForResult) return { json: base, pairedItem: { item: i } };

	const timeoutMs = (this.getNodeParameter('timeout', i) as number) * 1000;
	const startedAt = Date.now();
	let status = job.status as string | undefined;
	let statusResponse: IDataObject = job;
	let delayMs = 2000;
	while (status !== 'COMPLETED') {
		if (status === 'FAILED') {
			throw new NodeApiError(this.getNode(), statusResponse as JsonObject, {
				itemIndex: i,
				message: `The ${resource} job failed`,
				description: `Request ${String(job.request_id)} failed${
					statusResponse.refunded === true ? '; its price was returned to your balance' : ''
				}. ${typeof statusResponse.error === 'string' ? statusResponse.error : ''}`.trim(),
			});
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new NodeOperationError(
				this.getNode(),
				`The ${resource} job is still running after ${timeoutMs / 1000} seconds`,
				{
					itemIndex: i,
					description: `Fetch it later with Job → Get Result and request ID ${String(job.request_id)}.`,
				},
			);
		}
		await sleep(delayMs);
		delayMs = Math.min(delayMs + 1000, 5000);
		statusResponse = await megaBrainApiRequest.call(this, 'GET', String(job.status_url));
		status = statusResponse.status as string | undefined;
	}

	const output = await megaBrainApiRequest.call(this, 'GET', String(job.response_url));
	const urls = extractUrls(output);
	const result: INodeExecutionData = {
		json: { ...base, status: 'COMPLETED', url: urls[0], urls, output },
		pairedItem: { item: i },
	};

	const download = this.getNodeParameter('download', i, false) as boolean;
	if (download && urls[0]) {
		const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
		const file = (await this.helpers.httpRequest({
			method: 'GET',
			url: urls[0],
			encoding: 'arraybuffer',
			returnFullResponse: true,
		})) as { body: ArrayBuffer; headers: IDataObject };
		const mimeType =
			typeof file.headers['content-type'] === 'string'
				? (file.headers['content-type'] as string).split(';')[0].trim()
				: undefined;
		// File URLs end in an index (…/media/files/<id>/0), so name the file after the job.
		const extension = (mimeType?.split('/')[1] ?? (resource === 'video' ? 'mp4' : 'png'))
			.replace('jpeg', 'jpg')
			.replace('quicktime', 'mov');
		const fileName = `${resource}-${String(job.request_id ?? 'result')}.${extension}`;
		result.binary = {
			[binaryPropertyName]: await this.helpers.prepareBinaryData(
				Buffer.from(file.body),
				fileName,
				mimeType,
			),
		};
	}
	return result;
}
