import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { WhatsappGroupSchema } from './entity/WhatsappGroup.js'

export const AppDataSource = new DataSource({
	type: 'better-sqlite3',
	database: 'whatsapp.db',
	synchronize: true,
	logging: false,
	entities: [WhatsappGroupSchema],
})
