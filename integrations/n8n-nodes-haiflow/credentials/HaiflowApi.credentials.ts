import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class HaiflowApi implements ICredentialType {
	name = 'haiflowApi';

	displayName = 'Haiflow API';

	documentationUrl = 'https://github.com/coderz/haiflow';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:3333',
			placeholder: 'http://localhost:3333',
			description: 'Base URL of the haiflow server, without a trailing slash',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description:
				'The HAIFLOW_API_KEY used as a bearer token. All endpoints except /health and /hooks/* require it.',
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
			baseURL: '={{$credentials.baseUrl}}',
			url: '/sessions',
			method: 'GET',
		},
	};
}
