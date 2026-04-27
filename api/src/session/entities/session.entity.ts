import { Message } from "src/messages/entities/message.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToMany(() => Message, (message) => message.session )
  messages: Message[]

  @Column({ type: 'text' })
  sessionId: string;

  @Column({ type: 'text' })
  nameSession: string;

  @Column({ type: 'text', nullable: true })
  numberSession: string;

  @Column({
    type: 'enum',
    enum: ['open', 'close', 'connecting', 'not_started'],
    default: 'not_started',
    nullable: true
  })
  status: 'open' | 'close' | 'connecting' | 'not_started';

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn({ type: 'timestamp', name: 'deleted_at' })
  deleted_at: Date;
}
