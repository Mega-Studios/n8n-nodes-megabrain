import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';

export const DEFAULT_BASE_URL = 'https://getmegabrain.com/api/gateway/v1';

export const CREDENTIAL_NAME = 'megaBrainApi';

/** One field of a media model, as `GET /media/models` returns it. */
export interface MediaModelParameter {
	name: string;
	type: string;
	required?: boolean;
	default?: unknown;
	values?: string[];
	description?: string;
}

/** One media model, as `GET /media/models` returns it. */
export interface MediaModel {
	id: string;
	name: string;
	kind: 'image' | 'video';
	description?: string;
	accepts_image?: boolean;
	pricing?: { unit?: string; usd?: number };
	parameters: MediaModelParameter[];
}

/** One text model, as `GET /models` returns it. */
export interface TextModel {
	id: string;
	name?: string;
	pricing?: { prompt?: string; completion?: string };
}

export async function getBaseUrl(this: IExecuteFunctions | ILoadOptionsFunctions): Promise<string> {
	let baseUrl = DEFAULT_BASE_URL;
	try {
		const credentials = await this.getCredentials(CREDENTIAL_NAME);
		if (typeof credentials.baseUrl === 'string' && credentials.baseUrl.trim() !== '') {
			baseUrl = credentials.baseUrl.trim();
		}
	} catch {
		// No credential selected yet (for example while the user browses the model list):
		// the catalogs are public, so the default address is enough.
		baseUrl = DEFAULT_BASE_URL;
	}
	return baseUrl.replace(/\/+$/, '');
}

/** A request to the MegaBrain API signed with the user's key. */
export async function megaBrainApiRequest(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	pathOrUrl: string,
	body?: IDataObject,
	extra: Partial<IHttpRequestOptions> = {},
): Promise<IDataObject> {
	const url = /^https?:\/\//.test(pathOrUrl)
		? pathOrUrl
		: `${await getBaseUrl.call(this)}${pathOrUrl}`;
	const options: IHttpRequestOptions = {
		method,
		url,
		json: true,
		headers: { 'User-Agent': 'n8n-nodes-megabrain' },
		...extra,
	};
	if (body !== undefined) {
		options.body = body;
	}
	return (await this.helpers.httpRequestWithAuthentication.call(
		this,
		CREDENTIAL_NAME,
		options,
	)) as IDataObject;
}

/** The public media model catalog (no key needed). */
export async function fetchMediaModels(
	this: IExecuteFunctions | ILoadOptionsFunctions,
): Promise<MediaModel[]> {
	const baseUrl = await getBaseUrl.call(this);
	const response = (await this.helpers.httpRequest({
		method: 'GET',
		url: `${baseUrl}/media/models`,
		json: true,
	})) as { data?: MediaModel[] };
	return response.data ?? [];
}

/** The public text model catalog (no key needed). */
export async function fetchTextModels(this: ILoadOptionsFunctions): Promise<TextModel[]> {
	const baseUrl = await getBaseUrl.call(this);
	const response = (await this.helpers.httpRequest({
		method: 'GET',
		url: `${baseUrl}/models`,
		json: true,
	})) as { data?: TextModel[] };
	return response.data ?? [];
}

export function formatMediaPrice(model: MediaModel): string {
	const usd = model.pricing?.usd;
	const unit = model.pricing?.unit;
	if (typeof usd !== 'number' || !unit) return '';
	return `$${usd} per ${unit === 'second' ? 'second of video' : unit}`;
}

/** Maps a ratio such as 16:9 to the named sizes of models that take `image_size`. */
const RATIO_TO_IMAGE_SIZE: Record<string, string> = {
	'1:1': 'square_hd',
	'4:3': 'landscape_4_3',
	'3:4': 'portrait_4_3',
	'16:9': 'landscape_16_9',
	'9:16': 'portrait_16_9',
};

/**
 * Puts the node's friendly fields into the request body under the names the chosen model
 * takes, and leaves out the ones it does not take (an unknown field would get a 400).
 */
export function buildMediaInput(
	model: MediaModel | undefined,
	fields: {
		prompt: string;
		imageUrls?: string[];
		startImageUrl?: string;
		endImageUrl?: string;
		aspectRatio?: string;
		resolution?: string;
		numImages?: number;
		duration?: string;
		generateAudio?: boolean;
		negativePrompt?: string;
		seed?: number;
		outputFormat?: string;
	},
	extra: IDataObject,
): { body: IDataObject; skipped: string[] } {
	const accepted = new Set((model?.parameters ?? []).map((p) => p.name));
	// Without the catalog we cannot tell, so send everything the user filled in.
	const takes = (name: string) => model === undefined || accepted.has(name);
	const body: IDataObject = { prompt: fields.prompt };
	const skipped: string[] = [];
	const put = (name: string, value: unknown, label: string) => {
		if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;
		if (takes(name)) body[name] = value as IDataObject[keyof IDataObject];
		else skipped.push(label);
	};

	put('image_urls', fields.imageUrls, 'Image URLs');
	if (fields.startImageUrl) {
		if (takes('start_image_url')) body.start_image_url = fields.startImageUrl;
		else if (takes('first_frame_url')) body.first_frame_url = fields.startImageUrl;
		else if (takes('image_urls')) body.image_urls = [fields.startImageUrl];
		else skipped.push('Start Image URL');
	}
	if (fields.endImageUrl) {
		if (takes('end_image_url')) body.end_image_url = fields.endImageUrl;
		else if (takes('last_frame_url')) body.last_frame_url = fields.endImageUrl;
		else skipped.push('End Image URL');
	}
	if (fields.aspectRatio) {
		if (takes('aspect_ratio')) body.aspect_ratio = fields.aspectRatio;
		else if (takes('image_size') && RATIO_TO_IMAGE_SIZE[fields.aspectRatio])
			body.image_size = RATIO_TO_IMAGE_SIZE[fields.aspectRatio];
		else skipped.push('Aspect Ratio');
	}
	put('resolution', fields.resolution, 'Resolution');
	put('num_images', fields.numImages, 'Number of Images');
	put('duration', fields.duration, 'Duration');
	put('generate_audio', fields.generateAudio, 'Generate Audio');
	put('negative_prompt', fields.negativePrompt, 'Negative Prompt');
	put('seed', fields.seed, 'Seed');
	put('output_format', fields.outputFormat, 'Output Format');

	return { body: { ...body, ...extra }, skipped };
}

/** All file URLs in a model output: `{images: [{url}]}`, `{image: {url}}`, `{video: {url}}`. */
export function extractUrls(output: IDataObject): string[] {
	const urls: string[] = [];
	const visit = (value: unknown) => {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		const record = value as IDataObject;
		if (typeof record.url === 'string') urls.push(record.url);
		for (const key of ['images', 'image', 'video', 'videos', 'audio']) {
			if (key in record) visit(record[key]);
		}
	};
	visit(output);
	return urls;
}

export function splitUrls(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const list = Array.isArray(value) ? value : value.split(/[\s,]+/);
	return list.map((url) => url.trim()).filter((url) => url !== '');
}
