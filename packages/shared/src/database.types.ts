export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  notesdb: {
    Tables: {
      api_tokens: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          owner_id: string
          revoked_at: string | null
          scopes: string[]
          token_hash: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          owner_id: string
          revoked_at?: string | null
          scopes: string[]
          token_hash: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          owner_id?: string
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string
          token_prefix?: string
        }
        Relationships: []
      }
      attachments: {
        Row: {
          bucket: string
          checksum_sha256: string | null
          created_at: string
          deleted_at: string | null
          extraction_error: string | null
          extraction_status: string
          id: string
          mime_type: string
          note_id: string
          object_path: string
          original_file_name: string
          owner_id: string
          size_bytes: number
          updated_at: string
        }
        Insert: {
          bucket?: string
          checksum_sha256?: string | null
          created_at?: string
          deleted_at?: string | null
          extraction_error?: string | null
          extraction_status?: string
          id?: string
          mime_type: string
          note_id: string
          object_path: string
          original_file_name: string
          owner_id: string
          size_bytes: number
          updated_at?: string
        }
        Update: {
          bucket?: string
          checksum_sha256?: string | null
          created_at?: string
          deleted_at?: string | null
          extraction_error?: string | null
          extraction_status?: string
          id?: string
          mime_type?: string
          note_id?: string
          object_path?: string
          original_file_name?: string
          owner_id?: string
          size_bytes?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attachments_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      note_blocks: {
        Row: {
          block_key: string
          block_type: string
          content: string
          content_hash: string
          copyable: boolean
          created_at: string
          id: string
          language: string | null
          note_id: string
          owner_id: string
          position: number
          title: string | null
          updated_at: string
        }
        Insert: {
          block_key: string
          block_type: string
          content: string
          content_hash: string
          copyable?: boolean
          created_at?: string
          id?: string
          language?: string | null
          note_id: string
          owner_id: string
          position: number
          title?: string | null
          updated_at?: string
        }
        Update: {
          block_key?: string
          block_type?: string
          content?: string
          content_hash?: string
          copyable?: boolean
          created_at?: string
          id?: string
          language?: string | null
          note_id?: string
          owner_id?: string
          position?: number
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_blocks_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      note_mutations: {
        Row: {
          created_at: string
          mutation_id: string
          note_id: string
          operation: string
          owner_id: string
          request_hash: string
          response: Json
          resulting_version: number
        }
        Insert: {
          created_at?: string
          mutation_id: string
          note_id: string
          operation: string
          owner_id: string
          request_hash: string
          response: Json
          resulting_version: number
        }
        Update: {
          created_at?: string
          mutation_id?: string
          note_id?: string
          operation?: string
          owner_id?: string
          request_hash?: string
          response?: Json
          resulting_version?: number
        }
        Relationships: []
      }
      note_shares: {
        Row: {
          classification: string | null
          created_at: string
          expires_at: string | null
          id: string
          note_id: string
          owner_id: string
          revoked_at: string | null
          snapshot_content_markdown: string | null
          snapshot_title: string | null
          source_content_hash: string | null
          source_updated_at: string | null
          source_version: number | null
          token_hash: string
          token_prefix: string
        }
        Insert: {
          classification?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          note_id: string
          owner_id: string
          revoked_at?: string | null
          snapshot_content_markdown?: string | null
          snapshot_title?: string | null
          source_content_hash?: string | null
          source_updated_at?: string | null
          source_version?: number | null
          token_hash: string
          token_prefix: string
        }
        Update: {
          classification?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          note_id?: string
          owner_id?: string
          revoked_at?: string | null
          snapshot_content_markdown?: string | null
          snapshot_title?: string | null
          source_content_hash?: string | null
          source_updated_at?: string | null
          source_version?: number | null
          token_hash?: string
          token_prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_shares_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      notebooks: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          content_markdown: string
          content_plain: string
          created_at: string
          dedupe_key: string | null
          deleted_at: string | null
          id: string
          last_mutation_id: string
          notebook_id: string | null
          owner_id: string
          slug: string
          tags: string[]
          title: string
          updated_at: string
          updated_by_device_id: string
          version: number
        }
        Insert: {
          content_markdown?: string
          content_plain?: string
          created_at?: string
          dedupe_key?: string | null
          deleted_at?: string | null
          id: string
          last_mutation_id: string
          notebook_id?: string | null
          owner_id: string
          slug: string
          tags?: string[]
          title: string
          updated_at?: string
          updated_by_device_id: string
          version?: number
        }
        Update: {
          content_markdown?: string
          content_plain?: string
          created_at?: string
          dedupe_key?: string | null
          deleted_at?: string | null
          id?: string
          last_mutation_id?: string
          notebook_id?: string | null
          owner_id?: string
          slug?: string
          tags?: string[]
          title?: string
          updated_at?: string
          updated_by_device_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "notes_notebook_id_fkey"
            columns: ["notebook_id"]
            isOneToOne: false
            referencedRelation: "notebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      search_documents: {
        Row: {
          content: string
          content_hash: string
          created_at: string
          embedding: string | null
          embedding_error: string | null
          embedding_model: string | null
          embedding_model_version: string | null
          embedding_input_hash: string | null
          embedding_queued_at: string | null
          embedding_status: string
          embedding_attempts: number
          embedding_mode: string
          heading_path: string | null
          id: string
          note_id: string
          owner_id: string
          position: number
          page_number: number | null
          search_vector: unknown
          source_id: string | null
          source_key: string
          source_title: string
          source_type: string
          updated_at: string
        }
        Insert: {
          content: string
          content_hash: string
          created_at?: string
          embedding?: string | null
          embedding_error?: string | null
          embedding_model?: string | null
          embedding_model_version?: string | null
          embedding_input_hash?: string | null
          embedding_queued_at?: string | null
          embedding_status?: string
          embedding_attempts?: number
          embedding_mode?: string
          heading_path?: string | null
          id?: string
          note_id: string
          owner_id: string
          position: number
          search_vector?: unknown
          source_id?: string | null
          source_key: string
          source_title: string
          source_type: string
          updated_at?: string
        }
        Update: {
          content?: string
          content_hash?: string
          created_at?: string
          embedding?: string | null
          embedding_error?: string | null
          embedding_model?: string | null
          embedding_model_version?: string | null
          embedding_status?: string
          embedding_attempts?: number
          embedding_mode?: string
          heading_path?: string | null
          id?: string
          note_id?: string
          owner_id?: string
          position?: number
          page_number?: number | null
          search_vector?: unknown
          source_id?: string | null
          source_key?: string
          source_title?: string
          source_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_documents_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      qnotes_append_note: {
        Args: {
          p_blocks: Json
          p_content_markdown: string
          p_content_plain: string
          p_device_id: string
          p_documents: Json
          p_expected_version: number
          p_mutation_id: string
          p_note_id: string
          p_owner_id: string
          p_request_hash: string
        }
        Returns: Json
      }
      qnotes_archive_queue_message: {
        Args: { p_message_id: number; p_queue_name: string }
        Returns: boolean
      }
      qnotes_blocks_json: { Args: { p_note_id: string }; Returns: Json }
      qnotes_complete_attachment_processing: {
        Args: {
          p_attachment_id: string
          p_checksum_sha256: string
          p_documents: Json
          p_owner_id: string
        }
        Returns: Json
      }
      qnotes_create_note: {
        Args: {
          p_blocks: Json
          p_content_markdown: string
          p_content_plain: string
          p_device_id: string
          p_documents: Json
          p_dedupe_key: string | null
          p_mutation_id: string
          p_note_id: string
          p_notebook_id: string | null
          p_owner_id: string
          p_request_hash: string
          p_slug: string
          p_tags: string[] | null
          p_title: string
        }
        Returns: Json
      }
      qnotes_create_note_share: {
        Args: {
          p_classification: string
          p_confirm: boolean
          p_expires_at: string
          p_note_id: string
          p_owner_id: string
          p_expected_version: number
          p_snapshot_content_markdown: string
          p_snapshot_title: string
          p_source_content_hash: string
          p_token_hash: string
          p_token_prefix: string
        }
        Returns: Json
      }
      qnotes_delete_queue_message: {
        Args: { p_message_id: number; p_queue_name: string }
        Returns: boolean
      }
      qnotes_enqueue_embedding: {
        Args: { p_document_id: string; p_hash: string; p_input_hash?: string; p_model_version?: string; p_owner_id: string }
        Returns: undefined
      }
      qnotes_embedding_input: {
        Args: { p_content: string; p_heading_path: string; p_source_title: string }
        Returns: string
      }
      qnotes_embedding_input_hash: {
        Args: { p_content: string; p_heading_path: string; p_source_title: string }
        Returns: string
      }
      qnotes_fail_attachment_processing: {
        Args: {
          p_attachment_id: string
          p_error: string
          p_owner_id: string
          p_status: string
        }
        Returns: Json
      }
      qnotes_finalize_attachment: {
        Args: { p_attachment_id: string; p_owner_id: string }
        Returns: Json
      }
      qnotes_hybrid_search: {
        Args: {
          p_embedding: string
          p_filters: Json
          p_limit: number
          p_max_per_note: number
          p_offset: number
          p_owner_id: string
          p_query: string
          p_rrf_k?: number
        }
        Returns: {
          attachment_id: string
          block_key: string
          heading_path: string
          id: string
          keyword_rank: number
          language: string
          note_id: string
          note_slug: string
          note_title: string
          score: number
          semantic_rank: number
          snippet: string
          source_id: string
          source_key: string
          source_title: string
          source_type: string
        }[]
      }
      qnotes_keyword_search: {
        Args: { p_filters: Json; p_limit: number; p_max_per_note: number; p_offset: number; p_owner_id: string; p_query: string }
        Returns: {
          attachment_id: string
          block_key: string
          heading_path: string
          id: string
          keyword_rank: number
          language: string
          note_id: string
          note_slug: string
          note_title: string
          score: number
          semantic_rank: number
          snippet: string
          source_id: string
          source_key: string
          source_title: string
          source_type: string
        }[]
      }
      qnotes_move_note_to_notebook: {
        Args: {
          p_device_id: string
          p_expected_version: number
          p_mutation_id: string
          p_note_id: string
          p_notebook_id: string
          p_owner_id: string
          p_request_hash: string
        }
        Returns: Json
      }
      qnotes_note_json: {
        Args: { p_note: Database["notesdb"]["Tables"]["notes"]["Row"] }
        Returns: Json
      }
      qnotes_prepare_search_document: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      qnotes_read_queue: {
        Args: {
          p_batch_size: number
          p_queue_name: string
          p_visibility_seconds: number
        }
        Returns: {
          message: Json
          message_id: number
          read_count: number
        }[]
      }
      qnotes_reset_embedding_retry_state: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      qnotes_requeue_embedding_failures: {
        Args: { p_limit?: number }
        Returns: number
      }
      qnotes_requeue_embedding_mode_mismatches: {
        Args: { p_embedding_mode: string; p_limit?: number }
        Returns: number
      }
      qnotes_requeue_stale_embeddings: {
        Args: { p_stale_after?: string }
        Returns: number
      }
      qnotes_restore_note: {
        Args: {
          p_device_id: string
          p_expected_version: number
          p_mutation_id: string
          p_note_id: string
          p_owner_id: string
          p_request_hash: string
        }
        Returns: Json
      }
      qnotes_revoke_note_share: {
        Args: { p_note_id: string; p_owner_id: string }
        Returns: Json
      }
      qnotes_revoke_note_share_on_delete: {
        Args: Record<PropertyKey, never>
        Returns: undefined
      }
      qnotes_resolve_note_share: {
        Args: { p_token_hash: string }
        Returns: { content_markdown: string; title: string; updated_at: string }[]
      }
      qnotes_search_snippet: {
        Args: { p_content: string; p_query: string }
        Returns: string
      }
      qnotes_search_freshness: {
        Args: { p_owner_id: string }
        Returns: { failed_documents: number; oldest_queued_at: string; pending_documents: number }[]
      }
      qnotes_semantic_search: {
        Args: { p_embedding: string; p_filters: Json; p_limit: number; p_max_per_note: number; p_offset: number; p_owner_id: string; p_query: string }
        Returns: {
          attachment_id: string
          block_key: string
          heading_path: string
          id: string
          keyword_rank: number
          language: string
          note_id: string
          note_slug: string
          note_title: string
          score: number
          semantic_rank: number
          snippet: string
          source_id: string
          source_key: string
          source_title: string
          source_type: string
        }[]
      }
      qnotes_soft_delete_note: {
        Args: {
          p_device_id: string
          p_expected_version: number
          p_mutation_id: string
          p_note_id: string
          p_owner_id: string
          p_request_hash: string
        }
        Returns: Json
      }
      qnotes_sync_note_content: {
        Args: {
          p_blocks: Json
          p_documents: Json
          p_note_id: string
          p_owner_id: string
        }
        Returns: undefined
      }
      qnotes_sync_note_metadata: {
        Args: { p_note_id: string; p_owner_id: string }
        Returns: undefined
      }
      qnotes_update_note: {
        Args: {
          p_blocks: Json
          p_content_markdown: string
          p_content_plain: string
          p_device_id: string
          p_documents: Json
          p_expected_version: number
          p_mutation_id: string
          p_note_id: string
          p_owner_id: string
          p_request_hash: string
          p_slug: string
          p_tags: string[] | null
          p_title: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  notesdb: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
