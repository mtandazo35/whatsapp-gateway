import { Column, CreateDateColumn, DeleteDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { Rol } from "../dto/create-user.dto";

@Entity('users')
export class User {

    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'text', unique: true })
    email: string;

    @Column({ type: 'text' })
    password: string;

    @Column({ type: 'text' })
    usuario: string;

    @Column({ type: 'text', nullable: true })
    celular: string;

    @Column({
      type: 'enum',
      enum: Rol,
      default: Rol.USUARIO
    })
    rol: Rol;

    @Column({ type: 'bool', default: true })
    isActive: boolean;

    @CreateDateColumn()
    created_at: Date;

    @UpdateDateColumn()
    updated_at: Date;

    @DeleteDateColumn({ type: 'timestamp', name: 'deleted_at' })
    deleted_at: Date;
}
