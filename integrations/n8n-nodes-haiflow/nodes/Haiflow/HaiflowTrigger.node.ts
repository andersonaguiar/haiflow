import {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	NodeOperationError,
} from 'n8n-workflow';

const SECRET_HEADER = 'x-pipeline-secret';

export class HaiflowTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Haiflow Pipeline Trigger',
		name: 'haiflowTrigger',
		icon: 'file:haiflow.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=Pipeline webhook',
		description: 'Starts the workflow when haiflow posts an outbound pipeline event',
		defaults: {
			name: 'Haiflow Pipeline Trigger',
		},
		inputs: [],
		outputs: ['main'],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'haiflow-pipeline',
			},
		],
		properties: [
			{
				displayName:
					'Copy this node\'s Production webhook URL and add it to the target topic\'s "webhooks" array in haiflow\'s pipeline.json. haiflow will POST { topic, sourceSession, taskId, message, publishedAt } to it whenever that topic publishes.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Shared Secret',
				name: 'secret',
				type: 'string',
				typeOptions: {
					password: true,
				},
				default: '',
				description:
					'Optional. If set, incoming requests must send a matching X-Pipeline-Secret header, otherwise they are rejected.',
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const secret = this.getNodeParameter('secret', '') as string;

		if (secret) {
			const headerData = this.getHeaderData() as IDataObject;
			const provided = (headerData[SECRET_HEADER] ?? headerData[SECRET_HEADER.toUpperCase()]) as
				| string
				| undefined;
			if (provided !== secret) {
				throw new NodeOperationError(
					this.getNode(),
					'Pipeline secret mismatch: the X-Pipeline-Secret header did not match the configured shared secret.',
				);
			}
		}

		const body = this.getBodyData() as IDataObject;

		return {
			workflowData: [this.helpers.returnJsonArray([body])],
		};
	}
}
