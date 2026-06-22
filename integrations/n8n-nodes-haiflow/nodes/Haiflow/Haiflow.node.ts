import {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';

type HaiflowRequest = (
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
) => Promise<IDataObject>;

const CREDENTIALS_NAME = 'haiflowApi';

interface HaiflowCredentials {
	baseUrl: string;
	apiKey: string;
}

interface TriggerResponse {
	id?: string;
	session?: string;
	sent?: boolean;
	queued?: boolean;
	position?: number;
	prompt?: string;
}

interface StreamResult {
	ok: boolean;
	messages?: IDataObject[];
	error?: string;
	timedOut?: boolean;
}

/**
 * Strips any trailing slash so we can safely concatenate paths.
 */
function normaliseBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '');
}

/**
 * Joins an array of message objects into a single readable string.
 * haiflow messages can be plain strings or objects with a text/content field.
 */
function joinMessages(messages: IDataObject[]): string {
	return messages
		.map((message) => {
			if (typeof message === 'string') {
				return message;
			}
			const text = (message.text ?? message.content ?? message.message) as unknown;
			if (typeof text === 'string') {
				return text;
			}
			return JSON.stringify(message);
		})
		.join('\n');
}

export class Haiflow implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Haiflow',
		name: 'haiflow',
		icon: 'file:haiflow.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Orchestrate Claude Code through the haiflow HTTP API',
		defaults: {
			name: 'Haiflow',
		},
		// Using strings keeps the package decoupled from the n8n core enum at build time.
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: CREDENTIALS_NAME,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Trigger',
						value: 'trigger',
						description: 'Send a prompt to a haiflow session (POST /trigger)',
						action: 'Send a prompt to a session',
					},
					{
						name: 'Trigger and Wait',
						value: 'triggerAndWait',
						description:
							'Send a prompt then stream the response until it completes (POST /trigger then GET /responses/:id/stream)',
						action: 'Send a prompt and wait for the response',
					},
					{
						name: 'Get Response',
						value: 'getResponse',
						description: 'Fetch a response by task id (GET /responses/:id)',
						action: 'Get a response by id',
					},
					{
						name: 'Start Session',
						value: 'startSession',
						description: 'Start a haiflow session (POST /session/start)',
						action: 'Start a session',
					},
					{
						name: 'Stop Session',
						value: 'stopSession',
						description: 'Stop a haiflow session (POST /session/stop)',
						action: 'Stop a session',
					},
					{
						name: 'Publish Event',
						value: 'publishEvent',
						description: 'Publish a pipeline event (POST /publish)',
						action: 'Publish a pipeline event',
					},
					{
						name: 'List Sessions',
						value: 'listSessions',
						description: 'List all sessions and their status (GET /sessions)',
						action: 'List sessions',
					},
				],
				default: 'trigger',
			},

			// Trigger and Trigger and Wait shared fields
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				required: true,
				default: '',
				description: 'The prompt to send to the Claude Code session',
				displayOptions: {
					show: {
						operation: ['trigger', 'triggerAndWait'],
					},
				},
			},
			{
				displayName: 'Session',
				name: 'session',
				type: 'string',
				default: 'default',
				description: 'Name of the target session',
				displayOptions: {
					show: {
						operation: ['trigger', 'triggerAndWait'],
					},
				},
			},
			{
				displayName: 'Task ID',
				name: 'id',
				type: 'string',
				default: '',
				description:
					'Optional client supplied id for the task. Leave empty to let haiflow generate one.',
				displayOptions: {
					show: {
						operation: ['trigger', 'triggerAndWait'],
					},
				},
			},
			{
				displayName: 'Source',
				name: 'source',
				type: 'string',
				default: 'n8n',
				description: 'Label identifying where this prompt originated',
				displayOptions: {
					show: {
						operation: ['trigger', 'triggerAndWait'],
					},
				},
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 600,
				},
				default: 300,
				description:
					'How long to wait for the response stream before giving up. Capped server side at 600 seconds.',
				displayOptions: {
					show: {
						operation: ['triggerAndWait'],
					},
				},
			},

			// Get Response fields
			{
				displayName: 'Task ID',
				name: 'responseId',
				type: 'string',
				required: true,
				default: '',
				description: 'The id of the task to fetch the response for',
				displayOptions: {
					show: {
						operation: ['getResponse'],
					},
				},
			},
			{
				displayName: 'Session',
				name: 'responseSession',
				type: 'string',
				default: 'default',
				description: 'Name of the session that owns the task',
				displayOptions: {
					show: {
						operation: ['getResponse'],
					},
				},
			},

			// Start Session fields
			{
				displayName: 'Session',
				name: 'startSessionName',
				type: 'string',
				required: true,
				default: 'default',
				description: 'Name of the session to start',
				displayOptions: {
					show: {
						operation: ['startSession'],
					},
				},
			},
			{
				displayName: 'Working Directory',
				name: 'cwd',
				type: 'string',
				required: true,
				default: '',
				placeholder: '/path/to/project',
				description: 'Absolute path the session should run in',
				displayOptions: {
					show: {
						operation: ['startSession'],
					},
				},
			},

			// Stop Session fields
			{
				displayName: 'Session',
				name: 'stopSessionName',
				type: 'string',
				required: true,
				default: 'default',
				description: 'Name of the session to stop',
				displayOptions: {
					show: {
						operation: ['stopSession'],
					},
				},
			},

			// Publish Event fields
			{
				displayName: 'Topic',
				name: 'topic',
				type: 'string',
				required: true,
				default: '',
				description: 'The pipeline topic to publish to',
				displayOptions: {
					show: {
						operation: ['publishEvent'],
					},
				},
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				required: true,
				default: '',
				description: 'The message payload to publish',
				displayOptions: {
					show: {
						operation: ['publishEvent'],
					},
				},
			},
			{
				displayName: 'Session',
				name: 'publishSession',
				type: 'string',
				default: '',
				description: 'Optional source session for the published event',
				displayOptions: {
					show: {
						operation: ['publishEvent'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = (await this.getCredentials(CREDENTIALS_NAME)) as unknown as HaiflowCredentials;
		const baseUrl = normaliseBaseUrl(credentials.baseUrl);

		const request = async (
			method: IHttpRequestMethods,
			path: string,
			body?: IDataObject,
			qs?: IDataObject,
		): Promise<IDataObject> => {
			const options: IHttpRequestOptions = {
				method,
				url: `${baseUrl}${path}`,
				json: true,
			};
			if (body !== undefined) {
				options.body = body;
			}
			if (qs !== undefined) {
				options.qs = qs;
			}
			return (await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIALS_NAME,
				options,
			)) as IDataObject;
		};

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;

			try {
				let responseData: IDataObject | IDataObject[];

				if (operation === 'trigger') {
					const prompt = this.getNodeParameter('prompt', i) as string;
					const session = this.getNodeParameter('session', i) as string;
					const id = this.getNodeParameter('id', i, '') as string;
					const source = this.getNodeParameter('source', i, 'n8n') as string;

					const body: IDataObject = { prompt, session, source };
					if (id) {
						body.id = id;
					}
					responseData = await request('POST', '/trigger', body);
				} else if (operation === 'triggerAndWait') {
					responseData = await triggerAndWait(this, baseUrl, credentials.apiKey, i, request);
				} else if (operation === 'getResponse') {
					const id = this.getNodeParameter('responseId', i) as string;
					const session = this.getNodeParameter('responseSession', i, 'default') as string;
					responseData = await request(
						'GET',
						`/responses/${encodeURIComponent(id)}`,
						undefined,
						{ session },
					);
				} else if (operation === 'startSession') {
					const session = this.getNodeParameter('startSessionName', i) as string;
					const cwd = this.getNodeParameter('cwd', i) as string;
					responseData = await request('POST', '/session/start', { session, cwd });
				} else if (operation === 'stopSession') {
					const session = this.getNodeParameter('stopSessionName', i) as string;
					responseData = await request('POST', '/session/stop', { session });
				} else if (operation === 'publishEvent') {
					const topic = this.getNodeParameter('topic', i) as string;
					const message = this.getNodeParameter('message', i) as string;
					const session = this.getNodeParameter('publishSession', i, '') as string;
					const body: IDataObject = { topic, message };
					if (session) {
						body.session = session;
					}
					responseData = await request('POST', '/publish', body);
				} else if (operation === 'listSessions') {
					responseData = (await request('GET', '/sessions')) as unknown as IDataObject[];
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unknown operation: ${operation}`,
						{ itemIndex: i },
					);
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(responseData as IDataObject | IDataObject[]),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					const executionData = this.helpers.constructExecutionMetaData(
						this.helpers.returnJsonArray({ error: (error as Error).message }),
						{ itemData: { item: i } },
					);
					returnData.push(...executionData);
					continue;
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					throw error;
				}
				throw new NodeApiError(this.getNode(), error as JsonObject);
			}
		}

		return [returnData];
	}
}

/**
 * Sends a prompt then consumes the SSE response stream from
 * GET /responses/:id/stream. Returns the final messages joined as text and as
 * an array, or a clear status object for queued/timeout/error.
 */
async function triggerAndWait(
	ctx: IExecuteFunctions,
	baseUrl: string,
	apiKey: string,
	itemIndex: number,
	request: HaiflowRequest,
): Promise<IDataObject> {
		const prompt = ctx.getNodeParameter('prompt', itemIndex) as string;
		const session = ctx.getNodeParameter('session', itemIndex) as string;
		const id = ctx.getNodeParameter('id', itemIndex, '') as string;
		const source = ctx.getNodeParameter('source', itemIndex, 'n8n') as string;
		const requestedTimeout = ctx.getNodeParameter('timeout', itemIndex, 300) as number;
		const timeout = Math.min(Math.max(1, Math.floor(requestedTimeout)), 600);

		const triggerBody: IDataObject = { prompt, session, source };
		if (id) {
			triggerBody.id = id;
		}

		const trigger = (await request('POST', '/trigger', triggerBody)) as unknown as TriggerResponse;

		// 503 offline is surfaced as an error by httpRequest, so we reach here only when triggered.
		const taskId = trigger.id;
		if (!taskId) {
			throw new NodeOperationError(
				ctx.getNode(),
				'Trigger did not return a task id',
				{ itemIndex },
			);
		}

		const queuedNote =
			trigger.queued === true
				? { queued: true, position: trigger.position ?? null }
				: undefined;

		const result = await streamResponse(baseUrl, apiKey, taskId, session, timeout);

		if (result.ok) {
			const messages = result.messages ?? [];
			return {
				id: taskId,
				session: trigger.session ?? session,
				status: 'complete',
				prompt,
				response: joinMessages(messages),
				messages,
				...(queuedNote ?? {}),
			};
		}

		if (result.timedOut) {
			return {
				id: taskId,
				session: trigger.session ?? session,
				status: 'timeout',
				prompt,
				...(queuedNote ?? {}),
			};
		}

		throw new NodeOperationError(
			ctx.getNode(),
			`Haiflow response failed: ${result.error ?? 'unknown error'}`,
			{ itemIndex },
		);
}

/**
 * Consumes a haiflow SSE stream. Parses event/data blocks split on "\n\n".
 * Uses a plain fetch with the bearer header so we can read the response body
 * as a stream.
 */
async function streamResponse(
	baseUrl: string,
	apiKey: string,
	taskId: string,
	session: string,
	timeout: number,
): Promise<StreamResult> {
		const url =
			`${baseUrl}/responses/${encodeURIComponent(taskId)}/stream` +
			`?session=${encodeURIComponent(session)}&timeout=${timeout}`;

		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'text/event-stream',
			},
		});

		if (!res.ok || !res.body) {
			return { ok: false, error: `Stream request failed (${res.status})` };
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });

				let sep: number;
				while ((sep = buffer.indexOf('\n\n')) !== -1) {
					const block = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);

					const event = block.match(/^event:\s*(.*)$/m)?.[1]?.trim();
					const data = block
						.split('\n')
						.filter((line) => line.startsWith('data:'))
						.map((line) => line.slice(5).trim())
						.join('\n');

					if (!event) {
						continue;
					}
					if (event === 'complete') {
						try {
							const payload = JSON.parse(data) as { messages?: IDataObject[] };
							return { ok: true, messages: payload.messages ?? [] };
						} catch {
							return { ok: false, error: 'Failed to parse haiflow response' };
						}
					}
					if (event === 'error') {
						let message = 'Session error';
						try {
							message = (JSON.parse(data) as { error?: string }).error ?? message;
						} catch {
							// keep the default message
						}
						return { ok: false, error: message };
					}
					if (event === 'timeout') {
						return { ok: false, timedOut: true, error: 'timeout' };
					}
					// 'status' events mean still pending/queued: keep reading.
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				// stream already closed
			}
		}

		return { ok: false, error: 'Stream ended without a response' };
	}
