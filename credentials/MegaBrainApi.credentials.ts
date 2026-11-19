import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MegaBrainApi implements ICredentialType {
	name = 'megaBrainApi';

	displayName = 'MegaBrain API';

	icon: Icon = {
		light: 'file:../nodes/MegaBrain/megabrain.svg',
		dark: 'file:../nodes/MegaBrain/megabrain.dark.svg',
	};

	documentationUrl = 'https://getmegabrain.com/docs/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Your key from https://getmegabrain.com/keys',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://getmegabrain.com/api/gateway/v1',
			description: 'Leave as is unless MegaBrain support gave you another address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/key',
			method: 'GET',
		},
	};
}
