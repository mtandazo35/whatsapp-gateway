import { Session } from "src/session/entities/session.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('messages')
export class Message {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Session, (session) => session.messages)
  @JoinColumn({ name: 'session_id' })
  session: Session;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'text', nullable: true })
  receptor: string;

  @Column({ type: 'boolean', default: true })
  sent: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn({ type: 'timestamp', name: 'deleted_at' })
  deleted_at: Date;
}
