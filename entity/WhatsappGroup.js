import { EntitySchema } from 'typeorm'

export const WhatsappGroupSchema = new EntitySchema({
	name: 'WhatsappGroup',
	tableName: 'whatsapp_group',
	columns: {
		id: {
			type: 'integer',
			primary: true,
			generated: true,
		},
		groupName: {
			type: 'varchar',
			nullable: false,
		},
		whatsappGroupId: {
			type: 'varchar',
			unique: true,
			nullable: false,
		},
		isActive: {
			type: 'boolean',
			default: true,
			nullable: false,
		},
		createdAt: {
			type: 'datetime',
			createDate: true,
		},
		updatedAt: {
			type: 'datetime',
			updateDate: true,
		},
	},
})
