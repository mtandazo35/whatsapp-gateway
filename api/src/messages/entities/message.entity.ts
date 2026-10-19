import { Session } from "src/session/entities/session.entity";
import { User } from "src/user/entities/user.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

/**
 * Estados del ciclo de vida de un envío:
 *   queued     -> aceptado por la API y en cola (aún no enviado)
 *   sent       -> entregado al servidor de WhatsApp (SERVER_ACK)
 *   delivered  -> llegó al dispositivo destino
 *   read       -> leído
 *   played     -> audio reproducido
 *   failed     -> el worker agotó los intentos; ver lastError
 *   error      -> WhatsApp reportó error para ese mensaje
 */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'error' | 'pending' | string;

/** text: mensaje de texto; media_url: archivo descargado de una URL; file: archivo subido por multipart. */
export type MessageKind = 'text' | 'media_url' | 'file';

@Entity('messages')
export class Message {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Session, (session) => session.messages)
  @JoinColumn({ name: 'session_id' })
  session: Session;

  /** Usuario que pidió el envío (auditoría). Null en filas anteriores a 0.3.0. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'requested_by' })
  requestedBy: User | null;

  /** Texto, URL del archivo o nombre original del archivo subido, según kind. */
  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'varchar', length: 16, default: 'text' })
  kind: MessageKind;

  @Column({ type: 'text', nullable: true })
  caption: string | null;

  @Column({ type: 'boolean', default: false, name: 'fast_mode' })
  fastMode: boolean;

  @Column({ type: 'text', nullable: true })
  receptor: string;

  /** true solo cuando WhatsApp aceptó el mensaje. Nunca por defecto. */
  @Column({ type: 'boolean', default: false })
  sent: boolean;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'wa_message_id' })
  waMessageId: string;

  @Column({ type: 'varchar', length: 32, default: 'queued' })
  status: MessageStatus;

  @Column({ type: 'varchar', length: 512, nullable: true, name: 'last_error' })
  lastError: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @DeleteDateColumn({ type: 'timestamp', name: 'deleted_at' })
  deleted_at: Date;
}
