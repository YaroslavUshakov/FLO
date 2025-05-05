import sys
import psycopg2
from PySide6.QtWidgets import (QApplication, QMainWindow, QTableWidget, QTableWidgetItem,
                              QVBoxLayout, QWidget, QPushButton, QLabel, QMessageBox)
from PySide6.QtCore import Qt

class AdminPanel(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("История регистрации пользователей")
        self.setGeometry(100, 100, 700, 500)

        # Основной виджет и макет
        self.central_widget = QWidget()
        self.setCentralWidget(self.central_widget)
        self.layout = QVBoxLayout(self.central_widget)

        # Метка для количества пользователей
        self.user_count_label = QLabel("Количество пользователей: 0")
        self.layout.addWidget(self.user_count_label)

        # Таблица для пользователей
        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["ID", "Chat ID", "Username", "Menstruation Active", "Дата регистрации"])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.layout.addWidget(self.table)

        # Кнопка обновления
        self.refresh_button = QPushButton("Обновить список")
        self.refresh_button.clicked.connect(self.refresh_users)
        self.layout.addWidget(self.refresh_button)

        # Кнопка удаления
        self.delete_button = QPushButton("Удалить пользователя")
        self.delete_button.clicked.connect(self.delete_user)
        self.layout.addWidget(self.delete_button)

        # Подключение к базе данных
        self.conn = psycopg2.connect(
            dbname="menstrual_cycle",
            user="postgres",
            password="1234",
            host="localhost",
            port="5432"
        )
        self.refresh_users()

    def refresh_users(self):
        cursor = self.conn.cursor()
        cursor.execute("SELECT id, chat_id, username, menstruation_active, registration_date FROM users ORDER BY registration_date DESC")
        users = cursor.fetchall()

        self.table.setRowCount(len(users))
        for row, user in enumerate(users):
            for col, value in enumerate(user):
                if col == 4:  # Форматирование даты
                    item = QTableWidgetItem(value.strftime("%d.%m.%Y %H:%M:%S") if value else "")
                else:
                    item = QTableWidgetItem(str(value) if value is not None else "")
                self.table.setItem(row, col, item)

        self.user_count_label.setText(f"Количество пользователей: {len(users)}")
        cursor.close()

    def delete_user(self):
        selected_rows = self.table.selectionModel().selectedRows()
        if not selected_rows:
            QMessageBox.warning(self, "Ошибка", "Выберите пользователя для удаления.")
            return

        user_id = self.table.item(selected_rows[0].row(), 0).text()  # ID в первой колонке
        reply = QMessageBox.question(self, "Подтверждение", f"Удалить пользователя с ID {user_id} и все его данные?",
                                     QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if reply == QMessageBox.Yes:
            cursor = self.conn.cursor()
            try:
                # Удаление связанных записей из cycles
                cursor.execute("DELETE FROM cycles WHERE user_id = %s", (user_id,))
                # Удаление связанных записей из sexual_activities
                cursor.execute("DELETE FROM sexual_activities WHERE user_id = %s", (user_id,))
                # Удаление пользователя из users
                cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
                self.conn.commit()
                QMessageBox.information(self, "Успех", f"Пользователь с ID {user_id} удалён.")
                self.refresh_users()
            except psycopg2.Error as e:
                self.conn.rollback()
                QMessageBox.critical(self, "Ошибка", f"Ошибка при удалении: {e}")
            finally:
                cursor.close()

    def closeEvent(self, event):
        self.conn.close()
        event.accept()

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = AdminPanel()
    window.show()
    sys.exit(app.exec())