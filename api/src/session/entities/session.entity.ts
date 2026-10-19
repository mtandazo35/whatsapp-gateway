import { Message } from "src/messages/entities/message.entity";
import { User } from "src/user/entities/user.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToMany(() => Message, (message) => message.session )
  messages: Message[]

  /**
   * Dueño de la sesión. Los no administradores solo ven y usan sus sesiones.
   * Nullable para no romper filas anteriores a este campo (quedan solo para admins).
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'owner_id' })
  owner: User | null;

  /** Identificador público corto (12 hex). Es el que usan la API y la carpeta de credenciales. */
  @Column({ type: 'text', unique: true })
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
